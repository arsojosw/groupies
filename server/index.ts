import { createServer } from "http";
import { randomBytes, randomUUID } from "crypto";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import {
  db, loadDb, save, newSession, accountFromSession, endSession,
  createGm, checkLogin, createPlayer, activeInvites, findInvite,
} from "./store";
import type { Account, Campaign, Msg, Token } from "./store";

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: "*" } });

const MAP_W = 600;
const MAP_H = 400;
const CELL = 40;
const MAX_TOKENS = 50;
const COLORS = ["#378ADD", "#D85A30", "#2ecc71", "#f1c40f", "#9b59b6", "#1abc9c", "#e84393", "#e67e22"];

type Cb = (res: Record<string, unknown>) => void;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const gmRoom = (c: Campaign) => `gm:${c.id}`;
const playerRoom = (c: Campaign) => `pl:${c.id}`;
const acctRoom = (id: string) => `acct:${id}`;
const everyone = (c: Campaign) => [gmRoom(c), playerRoom(c)];

// Simple per-connection rate limit
function allow(socket: Socket, key: string, max: number, windowMs: number) {
  const rl: Record<string, number[]> = (socket.data.rl ??= {});
  const now = Date.now();
  const hits = (rl[key] ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    rl[key] = hits;
    return false;
  }
  hits.push(now);
  rl[key] = hits;
  return true;
}

// Validates everything coming from a browser before it is stored
function clean(raw: Partial<Token>, id: string, camp: Campaign): Token {
  const size = clamp(Math.round(Number(raw.size) || 1), 1, 5);
  const color = typeof raw.color === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : "#888888";
  const label = String(raw.label ?? "").trim().slice(0, 20) || "Token";
  const ownerId = typeof raw.ownerId === "string" && camp.memberIds.includes(raw.ownerId) ? raw.ownerId : null;
  const maxHp = clamp(Math.round(Number(raw.maxHp) || 10), 1, 9999);
  const hp = clamp(Math.round(raw.hp === undefined ? maxHp : Number(raw.hp) || 0), 0, maxHp);
  const x = clamp(Number(raw.x) || 0, 0, MAP_W - size * CELL);
  const y = clamp(Number(raw.y) || 0, 0, MAP_H - size * CELL);
  return { id, x, y, color, label, size, ownerId, hp, maxHp };
}

// Players do not see the HP of GM tokens (monsters)
function forPlayers(t: Token) {
  if (t.ownerId !== null) return t;
  const { hp, maxHp, ...rest } = t;
  return rest;
}

function tokensFor(camp: Campaign, acc: Account) {
  if (acc.role === "gm") return camp.tokens;
  return Object.fromEntries(Object.entries(camp.tokens).map(([id, t]) => [id, forPlayers(t)]));
}

function emitToken(camp: Campaign, event: string, t: Token) {
  io.to(gmRoom(camp)).emit(event, t);
  io.to(playerRoom(camp)).emit(event, forPlayers(t));
}

function membersOf(camp: Campaign) {
  return [camp.gmId, ...camp.memberIds]
    .map((id) => db.accounts[id])
    .filter(Boolean)
    .map((a) => ({ id: a.id, name: a.name, role: a.role }));
}

const canSee = (m: Msg, id: string) => m.to === null || m.fromId === id || m.to.includes(id);

function roll(formula: string) {
  const f = formula.replace(/\s/g, "").toLowerCase();
  const m = f.match(/^(\d*)d(\d+)(?:(kh|kl)(\d*))?([+-]\d+)?$/);
  if (!m) return null;
  const n = Math.min(parseInt(m[1] || "1"), 100);
  const sides = parseInt(m[2]);
  const mode = m[3]; // "kh", "kl" or undefined
  const keepN = mode ? parseInt(m[4] || "1") : n;
  const mod = parseInt(m[5] || "0");
  if (n < 1 || sides < 2 || sides > 1000 || keepN < 1 || keepN > n) return null;
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
  // Dice positions sorted best-first, then keep the first keepN
  const order = rolls
    .map((_, i) => i)
    .sort((a, b) => (mode === "kl" ? rolls[a] - rolls[b] : rolls[b] - rolls[a]));
  const kept = new Set(order.slice(0, keepN));
  const keep = rolls.map((_, i) => kept.has(i));
  const total = rolls.reduce((sum, v, i) => sum + (keep[i] ? v : 0), 0) + mod;
  return { formula: f, rolls, sides, keep, total };
}

// Recipients: null = everyone, array = private, undefined = invalid
function parseTo(raw: unknown, camp: Campaign): string[] | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return undefined;
  const valid = new Set([camp.gmId, ...camp.memberIds]);
  const ids = [...new Set(raw.filter((x): x is string => typeof x === "string" && valid.has(x)))].slice(0, 10);
  return ids.length > 0 ? ids : undefined;
}

function postMsg(camp: Campaign, acc: Account, part: Pick<Msg, "to" | "kind" | "text" | "roll">) {
  const msg: Msg = { id: randomUUID(), ts: Date.now(), fromId: acc.id, fromName: acc.name, ...part };
  camp.messages.push(msg);
  if (camp.messages.length > 200) camp.messages.splice(0, camp.messages.length - 200);
  save();
  const rooms = msg.to === null ? everyone(camp) : [acctRoom(acc.id), ...msg.to.map((id) => acctRoom(id))];
  io.to(rooms).emit("chat", msg);
}

function sendInit(socket: Socket, acc: Account, camp: Campaign) {
  socket.emit("init", {
    me: { id: acc.id, name: acc.name, role: acc.role },
    campaign: { name: camp.name },
    members: membersOf(camp),
    tokens: tokensFor(camp, acc),
    messages: camp.messages.filter((m) => canSee(m, acc.id)).slice(-50),
    invites: acc.role === "gm" ? activeInvites(camp) : undefined,
  });
}

type Patch = { id: string; label?: string; color?: string; size?: number; ownerId?: string | null; hp?: number; maxHp?: number };

io.on("connection", (socket) => {
  const session = socket.handshake.auth?.session;
  const acc0 = accountFromSession(session);
  const camp0 = acc0 ? db.campaigns[acc0.campaignId] : undefined;
  const ctx = acc0 && camp0 ? { acc: acc0, camp: camp0 } : null;

  // ---------- available before signing in ----------
  socket.on("register", async (p: { username?: string; password?: string; campaignName?: string }, cb?: Cb) => {
    if (typeof cb !== "function") return;
    if (!allow(socket, "auth", 5, 60_000)) return cb({ error: "Too many attempts, wait a minute" });
    const res = await createGm(String(p?.username ?? ""), String(p?.password ?? ""), String(p?.campaignName ?? ""));
    if ("error" in res) return cb({ error: res.error });
    cb({ ok: true, session: newSession(res.account.id) });
  });

  socket.on("login", async (p: { username?: string; password?: string }, cb?: Cb) => {
    if (typeof cb !== "function") return;
    if (!allow(socket, "auth", 5, 60_000)) return cb({ error: "Too many attempts, wait a minute" });
    const found = await checkLogin(String(p?.username ?? ""), String(p?.password ?? ""));
    if (!found) return cb({ error: "Wrong username or password" });
    cb({ ok: true, session: newSession(found.id) });
  });

  socket.on("join", (p: { code?: string; name?: string; session?: string }, cb?: Cb) => {
    if (typeof cb !== "function") return;
    if (!allow(socket, "join", 10, 60_000)) return cb({ error: "Too many attempts, wait a minute" });
    const found = findInvite(p?.code);
    if (!found) return cb({ error: "This invite link is invalid or has expired" });
    const { camp, inv } = found;

    const existing = accountFromSession(p?.session);
    if (existing && existing.campaignId === camp.id) return cb({ ok: true, session: p.session });

    const name = String(p?.name ?? "").trim().slice(0, 20);
    if (!name) return cb({ needName: true, campaign: camp.name });
    if (camp.memberIds.length >= 20) return cb({ error: "This table is full" });

    inv.uses += 1;
    const player = createPlayer(camp, name);
    const id = randomUUID();
    const n = Object.keys(camp.tokens).length;
    camp.tokens[id] = clean(
      { label: name, color: COLORS[camp.memberIds.length % COLORS.length], ownerId: player.id,
        x: 20 + (n % 10) * 30, y: 20 + (n % 10) * 30, hp: 10, maxHp: 10 },
      id, camp
    );
    save();
    emitToken(camp, "tokenAdded", camp.tokens[id]);
    io.to(everyone(camp)).emit("members", membersOf(camp));
    io.to(gmRoom(camp)).emit("invites", activeInvites(camp));
    cb({ ok: true, session: newSession(player.id) });
  });

  socket.on("hello", () => {
    if (ctx) sendInit(socket, ctx.acc, ctx.camp);
    else socket.emit("unauth");
  });

  if (!ctx) {
    socket.emit("unauth");
    return;
  }

  // ---------- signed in ----------
  const { acc, camp } = ctx;
  const isGm = acc.role === "gm";
  socket.join([acctRoom(acc.id), isGm ? gmRoom(camp) : playerRoom(camp)]);
  sendInit(socket, acc, camp);

  socket.on("logout", (cb?: () => void) => {
    endSession(session);
    cb?.();
  });

  // GM: invite links
  socket.on("createInvite", (p: { hours?: number; maxUses?: number }, cb?: Cb) => {
    if (!isGm) return;
    const hours = clamp(Number(p?.hours) || 24, 1, 168);
    const maxUses = clamp(Math.round(Number(p?.maxUses) || 6), 1, 20);
    if (activeInvites(camp).length >= 10) return cb?.({ error: "Too many active links. Revoke one first." });
    camp.invites.push({ code: randomBytes(9).toString("base64url"), expiresAt: Date.now() + hours * 3_600_000, maxUses, uses: 0 });
    save();
    io.to(gmRoom(camp)).emit("invites", camp.invites);
    cb?.({ ok: true });
  });

  socket.on("revokeInvite", (code: string) => {
    if (!isGm) return;
    camp.invites = camp.invites.filter((i) => i.code !== code);
    save();
    io.to(gmRoom(camp)).emit("invites", activeInvites(camp));
  });

  // GM: tokens
  socket.on("addToken", (raw: Partial<Token>) => {
    if (!isGm || !raw || typeof raw !== "object") return;
    const count = Object.keys(camp.tokens).length;
    if (count >= MAX_TOKENS) return;
    const id = randomUUID();
    const pos = 20 + (count % 10) * 30;
    camp.tokens[id] = clean({ ...raw, x: pos, y: pos }, id, camp);
    save();
    emitToken(camp, "tokenAdded", camp.tokens[id]);
  });

  socket.on("updateToken", (p: Patch) => {
    if (!isGm || !p) return;
    const cur = camp.tokens[p.id];
    if (!cur) return;
    camp.tokens[cur.id] = clean(
      {
        ...cur,
        label: p.label ?? cur.label,
        color: p.color ?? cur.color,
        size: p.size ?? cur.size,
        ownerId: p.ownerId === undefined ? cur.ownerId : p.ownerId,
        hp: p.hp ?? cur.hp,
        maxHp: p.maxHp ?? cur.maxHp,
      },
      cur.id, camp
    );
    save();
    emitToken(camp, "tokenUpdated", camp.tokens[cur.id]);
  });

  socket.on("removeToken", (id: string) => {
    if (!isGm || !camp.tokens[id]) return;
    delete camp.tokens[id];
    save();
    io.to(everyone(camp)).emit("tokenRemoved", id);
  });

  // Players: only their own token
  socket.on("setHp", ({ id, hp }: { id: string; hp: number }) => {
    const t = camp.tokens[id];
    if (!t || (!isGm && t.ownerId !== acc.id)) return;
    t.hp = clamp(Math.round(Number(hp) || 0), 0, t.maxHp);
    save();
    emitToken(camp, "tokenUpdated", t);
  });

  socket.on("move", ({ id, x, y }: { id: string; x: number; y: number }) => {
    const t = camp.tokens[id];
    if (!t || (!isGm && t.ownerId !== acc.id)) return;
    t.x = clamp(Number(x) || 0, 0, MAP_W - t.size * CELL);
    t.y = clamp(Number(y) || 0, 0, MAP_H - t.size * CELL);
    save();
    socket.to(everyone(camp)).emit("moved", { id, x: t.x, y: t.y });
  });

  // Chat and dice
  socket.on("chat", (p: { text?: string; to?: string[] | null }) => {
    if (!allow(socket, "chat", 20, 10_000)) return;
    const text = String(p?.text ?? "").trim().slice(0, 500);
    const to = parseTo(p?.to, camp);
    if (!text || to === undefined) return;
    postMsg(camp, acc, { to, kind: "text", text });
  });

  socket.on("roll", (p: { formula?: string; to?: string[] | null }) => {
    if (!allow(socket, "roll", 20, 10_000)) return;
    const result = roll(String(p?.formula ?? ""));
    const to = parseTo(p?.to, camp);
    if (!result || to === undefined) return;
    postMsg(camp, acc, { to, kind: "roll", roll: result });
  });
});

loadDb().then(() =>
  httpServer.listen(3001, () => {
    console.log("Server on http://localhost:3001");
    console.log("Open http://localhost:5173/ to create a GM account");
  })
);