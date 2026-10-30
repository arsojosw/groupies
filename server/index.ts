import express from "express";
import { createServer } from "http";
import { promises as fsp } from "fs";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import {
  db, loadDb, save, newSession, accountFromSession, endSession,
  createGm, checkLogin, createPlayer, activeInvites, findInvite,
} from "./store";
import type { Account, Campaign, Msg, Token } from "./store";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const CELL = 40;
const MAX_TOKENS = 50;
const MIN_MAP = 400;
const MAX_MAP = 4000;
const MAX_MAP_BYTES = 6 * 1024 * 1024;
const MAX_TOKEN_BYTES = 2 * 1024 * 1024;
const QUOTA_BYTES = 50 * 1024 * 1024; // per table
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const COLORS = ["#378ADD", "#D85A30", "#2ecc71", "#f1c40f", "#9b59b6", "#1abc9c", "#e84393", "#e67e22"];

type Cb = (res: Record<string, unknown>) => void;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const gmRoom = (c: Campaign) => `gm:${c.id}`;
const playerRoom = (c: Campaign) => `pl:${c.id}`;
const acctRoom = (id: string) => `acct:${id}`;
const everyone = (c: Campaign) => [gmRoom(c), playerRoom(c)];
const assetUrl = (c: Campaign, file: string) => `/uploads/${c.id}/${file}`;

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
  const x = clamp(Number(raw.x) || 0, 0, camp.map.w - size * CELL);
  const y = clamp(Number(raw.y) || 0, 0, camp.map.h - size * CELL);
  // A token image must be one of this table's own uploaded files
  const image =
    typeof raw.image === "string" && Object.values(camp.assets).some((a) => assetUrl(camp, a.file) === raw.image)
      ? raw.image
      : undefined;
  return { id, x, y, color, label, size, ownerId, hp, maxHp, image };
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

// Dice: NdS, optional kh/kl (keep highest/lowest), optional +/- modifier
function roll(formula: string) {
  const f = formula.replace(/\s/g, "").toLowerCase();
  const m = f.match(/^(\d*)d(\d+)(?:(kh|kl)(\d*))?([+-]\d+)?$/);
  if (!m) return null;
  const n = Math.min(parseInt(m[1] || "1"), 100);
  const sides = parseInt(m[2]);
  const mode = m[3];
  const keepN = mode ? parseInt(m[4] || "1") : n;
  const mod = parseInt(m[5] || "0");
  if (n < 1 || sides < 2 || sides > 1000 || keepN < 1 || keepN > n) return null;
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
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
    map: camp.map,
    members: membersOf(camp),
    tokens: tokensFor(camp, acc),
    messages: camp.messages.filter((m) => canSee(m, acc.id)).slice(-50),
    invites: acc.role === "gm" ? activeInvites(camp) : undefined,
  });
}

// Delete uploaded files that nothing uses any more
function gcAssets(camp: Campaign) {
  const used = new Set<string>();
  if (camp.map.image) used.add(camp.map.image);
  for (const t of Object.values(camp.tokens)) if (t.image) used.add(t.image);
  for (const [key, a] of Object.entries(camp.assets)) {
    if (used.has(assetUrl(camp, a.file))) continue;
    delete camp.assets[key];
    fsp.unlink(path.join(UPLOAD_DIR, camp.id, a.file)).catch(() => {});
  }
  save();
}

// After the map shrinks, pull tokens back inside it
function fitTokens(camp: Campaign) {
  for (const t of Object.values(camp.tokens)) {
    const x = clamp(t.x, 0, camp.map.w - t.size * CELL);
    const y = clamp(t.y, 0, camp.map.h - t.size * CELL);
    if (x !== t.x || y !== t.y) {
      t.x = x;
      t.y = y;
      emitToken(camp, "tokenUpdated", t);
    }
  }
}

// Check the real file type from its first bytes, not the name the browser claims
function sniff(b: Buffer): "png" | "jpg" | "webp" | null {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length > 12 && b.subarray(0, 8).equals(png)) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

// ---------- image files ----------
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    index: false,
    maxAge: "7d",
    immutable: true,
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
  })
);

app.post("/api/upload", express.raw({ type: () => true, limit: "6mb" }), async (req, res) => {
  try {
    const acc = accountFromSession((req.header("authorization") ?? "").replace(/^Bearer /, ""));
    const camp = acc ? db.campaigns[acc.campaignId] : undefined;
    if (!acc || !camp || acc.role !== "gm") {
      return void res.status(403).json({ error: "Only the GM can upload images" });
    }
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: "Empty upload" });

    const kind = String(req.query.kind);
    if (kind !== "map" && kind !== "token") return void res.status(400).json({ error: "Unknown upload type" });
    const ext = sniff(body);
    if (!ext) return void res.status(415).json({ error: "Use a PNG, JPG or WebP image" });
    if (body.length > (kind === "map" ? MAX_MAP_BYTES : MAX_TOKEN_BYTES)) {
      return void res.status(413).json({ error: "Image is too large" });
    }

    const tok = kind === "token" ? camp.tokens[String(req.query.tokenId)] : undefined;
    if (kind === "token" && !tok) return void res.status(404).json({ error: "Token not found" });

    // Storage limit (the image being replaced does not count)
    const replacedUrl = kind === "map" ? camp.map.image : tok?.image;
    const used = Object.values(camp.assets).reduce(
      (sum, a) => sum + (replacedUrl === assetUrl(camp, a.file) ? 0 : a.size),
      0
    );
    if (used + body.length > QUOTA_BYTES) {
      return void res.status(413).json({ error: "Storage full (50 MB). Remove some images first." });
    }

    const file = `${randomBytes(16).toString("hex")}.${ext}`;
    await fsp.mkdir(path.join(UPLOAD_DIR, camp.id), { recursive: true });
    await fsp.writeFile(path.join(UPLOAD_DIR, camp.id, file), body);
    camp.assets[file] = { file, size: body.length };
    const url = assetUrl(camp, file);

    if (kind === "map") {
      camp.map = {
        image: url,
        w: clamp(Math.round(Number(req.query.w)) || 2000, MIN_MAP, MAX_MAP),
        h: clamp(Math.round(Number(req.query.h)) || 2000, MIN_MAP, MAX_MAP),
      };
      fitTokens(camp);
      io.to(everyone(camp)).emit("map", camp.map);
    } else if (tok) {
      tok.image = url;
      emitToken(camp, "tokenUpdated", tok);
    }
    gcAssets(camp);
    res.json({ ok: true });
  } catch (e) {
    console.error("upload failed", e);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.use((err: { type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const big = err.type === "entity.too.large";
  res.status(big ? 413 : 400).json({ error: big ? "Image is too large" : "Bad request" });
});

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

  // GM: map settings (the image itself arrives through /api/upload)
  socket.on("setMap", (p: { w?: number; h?: number }) => {
    if (!isGm || !p) return;
    camp.map.w = clamp(Math.round(Number(p.w)) || camp.map.w, MIN_MAP, MAX_MAP);
    camp.map.h = clamp(Math.round(Number(p.h)) || camp.map.h, MIN_MAP, MAX_MAP);
    fitTokens(camp);
    save();
    io.to(everyone(camp)).emit("map", camp.map);
  });

  socket.on("clearMap", () => {
    if (!isGm) return;
    camp.map.image = undefined;
    gcAssets(camp);
    io.to(everyone(camp)).emit("map", camp.map);
  });

  // GM: tokens
  socket.on("addToken", (raw: Partial<Token>) => {
    if (!isGm || !raw || typeof raw !== "object") return;
    const count = Object.keys(camp.tokens).length;
    if (count >= MAX_TOKENS) return;
    const id = randomUUID();
    const pos = 20 + (count % 10) * 30;
    const hasPos = typeof raw.x === "number" && typeof raw.y === "number";
    camp.tokens[id] = clean({ ...raw, x: hasPos ? raw.x : pos, y: hasPos ? raw.y : pos }, id, camp);
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

  socket.on("clearTokenImage", (id: string) => {
    if (!isGm) return;
    const t = camp.tokens[id];
    if (!t) return;
    t.image = undefined;
    gcAssets(camp);
    emitToken(camp, "tokenUpdated", t);
  });

  socket.on("removeToken", (id: string) => {
    if (!isGm || !camp.tokens[id]) return;
    delete camp.tokens[id];
    gcAssets(camp);
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
    t.x = clamp(Number(x) || 0, 0, camp.map.w - t.size * CELL);
    t.y = clamp(Number(y) || 0, 0, camp.map.h - t.size * CELL);
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