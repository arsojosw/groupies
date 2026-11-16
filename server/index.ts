import express from "express";
import { createServer } from "http";
import { promises as fsp } from "fs";
import path from "path";
import { randomBytes, randomUUID } from "crypto";
import { Server } from "socket.io";
import type { Socket } from "socket.io";
import {
  db, loadDb, save, newSession, accountFromSession, endSession,
  createGm, checkLogin, createPlayer, ensureAdmin, activeInvites, listInvites, findInvite,
  setPassword, purgeOrphanSessions, logEvent, tierSetting, TIERS, DEFAULT_MEASURE,
} from "./store";
import type { Account, Campaign, Measure, Msg, Role, SceneMap, Tier, Token } from "./store";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const CELL = 40;
const MAX_TOKENS = 50; // tokens on one map
const MAX_LIBRARY = 200; // saved tokens
const MIN_MAP = 400;
const MAX_MAP = 4000;
const MAX_MAP_BYTES = 6 * 1024 * 1024;
const MAX_TOKEN_BYTES = 2 * 1024 * 1024;
const MAX_THUMB_BYTES = 300 * 1024; // map previews are small
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const COLORS = ["#378ADD", "#D85A30", "#2ecc71", "#f1c40f", "#9b59b6", "#1abc9c", "#e84393", "#e67e22"];

// Token actions (the buttons that appear when a token is selected)
const ACTION_LABELS: Record<string, string> = { sword: "Melee Attack", bow: "Ranged Attack" };
const AMMO = ["arrow", "gun"]; // ammo types the Ranged Attack accepts
const RANGED_HIT_CENTER = false; // false: the shot ends where it touches the target's edge; true: at its center
const MELEE_STOP_AT_CONTACT = true; // the attacker stops where its edge touches the edge of the target

type Cb = (res: Record<string, unknown>) => void;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const gmRoom = (c: Campaign) => `gm:${c.id}`;
const playerRoom = (c: Campaign) => `pl:${c.id}`;
const acctRoom = (id: string) => `acct:${id}`;
const everyone = (c: Campaign) => [gmRoom(c), playerRoom(c)];
const assetUrl = (c: Campaign, file: string) => `/uploads/${c.id}/${file}`;
const cleanName = (v: unknown, fallback: string) => String(v ?? "").trim().slice(0, 40) || fallback;

// Writes to the activity log and shows the entry live in the admin page
function record(actor: string, action: string, target?: string, detail?: string) {
  io.to("admin").emit("adminLog", logEvent(actor, action, target, detail));
}

// A GM whose paid period has ended becomes "not paid"
function checkExpiry(gm: Account): boolean {
  if (gm.role !== "gm" || gm.paid !== true || gm.paidUntil === undefined || gm.paidUntil > Date.now()) return false;
  gm.paid = false;
  save();
  record("system", "gm.expired", gm.username, `Paid period ended ${new Date(gm.paidUntil).toLocaleDateString()}`);
  io.to("admin").emit("adminGm", gmRow(gm));
  return true;
}

// A table is usable only while its GM is paid and the paid period has not ended
const isActive = (camp: Campaign) => {
  const gm = db.accounts[camp.gmId];
  if (!gm) return false;
  checkExpiry(gm);
  return gm.paid === true;
};

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

// Failed sign-ins per username, so one account cannot be guessed at forever
const failedLogins = new Map<string, number[]>();
const FAIL_LIMIT = 8;
const FAIL_WINDOW = 15 * 60_000;
function recentFails(user: string) {
  const now = Date.now();
  const hits = (failedLogins.get(user) ?? []).filter((t) => now - t < FAIL_WINDOW);
  failedLogins.set(user, hits);
  return hits.length;
}
function noteFail(user: string) {
  if (failedLogins.size > 5000) failedLogins.clear();
  const hits = failedLogins.get(user) ?? [];
  hits.push(Date.now());
  failedLogins.set(user, hits);
}

// Validates everything coming from a browser before it is stored
function clean(raw: Partial<Token>, id: string, camp: Campaign): Token {
  const size = clamp(Math.round(Number(raw.size) || 1), 1, 10);
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
  const rot = (((Math.round(Number(raw.rot)) || 0) % 360) + 360) % 360;
  const flip = raw.flip === true;
  const hidden = raw.hidden === true;
  const z = Math.round(Number(raw.z) || 0);
  return { id, x, y, color, label, size, ownerId, hp, maxHp, image, rot, flip, hidden, z };
}

// Players do not see the HP of GM tokens (monsters)
function forPlayers(t: Token) {
  if (t.ownerId !== null) return t;
  const { hp, maxHp, ...rest } = t;
  return rest;
}

// Players never receive hidden tokens at all
function tokensFor(camp: Campaign, role: Role) {
  if (role === "gm") return camp.tokens;
  return Object.fromEntries(
    Object.entries(camp.tokens)
      .filter(([, t]) => !t.hidden)
      .map(([id, t]) => [id, forPlayers(t)])
  );
}

function emitToken(camp: Campaign, event: string, t: Token) {
  io.to(gmRoom(camp)).emit(event, t);
  if (!t.hidden) io.to(playerRoom(camp)).emit(event, forPlayers(t));
}

// Layer number for a new token: above all others
const nextZ = (camp: Campaign) => Object.values(camp.tokens).reduce((m, t) => Math.max(m, t.z ?? 0), -1) + 1;

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

function postMsg(camp: Campaign, acc: Account, part: Pick<Msg, "to" | "kind" | "text" | "roll"> & { as?: string }) {
  const { as, ...rest } = part;
  const msg: Msg = { id: randomUUID(), ts: Date.now(), fromId: acc.id, fromName: as ?? acc.name, ...rest };
  camp.messages.push(msg);
  if (camp.messages.length > 200) camp.messages.splice(0, camp.messages.length - 200);
  save();
  const rooms = msg.to === null ? everyone(camp) : [acctRoom(acc.id), ...msg.to.map((id) => acctRoom(id))];
  io.to(rooms).emit("chat", msg);
}

// ---------- maps and library ----------
// What players need to know about the open map (never include its tokens here)
const mapInfo = (camp: Campaign) => ({
  id: camp.map.id, name: camp.map.name, image: camp.map.image, w: camp.map.w, h: camp.map.h,
});

const mapList = (camp: Campaign) =>
  Object.values(camp.maps)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => ({ id: m.id, name: m.name, w: m.w, h: m.h, image: m.image, thumb: m.thumb }));


// A saved token made from a map token stays in step with it (name, picture, size...)
function syncLibrary(camp: Campaign, t: Token) {
  const s = camp.library.find((x) => x.fromTokenId === t.id);
  if (!s) return;
  s.label = t.label;
  s.color = t.color;
  s.size = t.size;
  s.maxHp = t.maxHp;
  s.image = t.image;
  s.rot = t.rot;
  s.flip = t.flip;
  s.ownerId = t.ownerId;
  save();
  io.to(gmRoom(camp)).emit("library", camp.library);
}

// Copy a token into the library. Saving the same token again just updates its entry.
function saveToLibrary(camp: Campaign, t: Token): boolean {
  if (camp.library.some((x) => x.fromTokenId === t.id)) {
    syncLibrary(camp, t);
    return true;
  }
  if (camp.library.length >= MAX_LIBRARY) return false;
  camp.library.push({
    id: randomUUID(), label: t.label, color: t.color, size: t.size, maxHp: t.maxHp,
    image: t.image, rot: t.rot, flip: t.flip, ownerId: t.ownerId, savedAt: Date.now(), fromTokenId: t.id,
  });
  save();
  io.to(gmRoom(camp)).emit("library", camp.library);
  return true;
}    

function tierInfo(camp: Campaign) {
  const gm = db.accounts[camp.gmId];
  const t = tierSetting(gm);
  return {
    tier: gm?.tier ?? "free",
    maxMaps: t.maxMaps,
    mapCount: Object.keys(camp.maps).length,
    storageMb: t.storageMb,
    usedBytes: Object.values(camp.assets).reduce((s, a) => s + a.size, 0),
  };
}

// The GM's map list, open map and tier numbers
function sendMaps(camp: Campaign) {
  io.to(gmRoom(camp)).emit("maps", { activeMapId: camp.activeMapId, maps: mapList(camp), tier: tierInfo(camp) });
}

// Everyone gets the open map and its tokens (players without hidden tokens)
function broadcastScene(camp: Campaign) {
  io.to(gmRoom(camp)).emit("scene", { map: mapInfo(camp), tokens: tokensFor(camp, "gm") });
  io.to(playerRoom(camp)).emit("scene", { map: mapInfo(camp), tokens: tokensFor(camp, "player") });
  sendInitiative(camp);
}

const measureOf = (camp: Campaign): Measure => ({ ...DEFAULT_MEASURE, ...camp.measure });
// ---------- initiative ----------
const initDie = (camp: Campaign) => (camp.initiativeDie === 6 || camp.initiativeDie === 10 ? camp.initiativeDie : 20);

// The initiative of the open map (every map keeps its own)
function initOf(camp: Campaign) {
  return (camp.map.initiative ??= { active: false, startedAt: 0, entries: [] });
}

// Players do not get the entries of hidden tokens
function initiativeFor(camp: Campaign, role: Role) {
  const i = initOf(camp);
  const entries =
    role === "gm"
      ? i.entries
      : i.entries.filter((e) => camp.tokens[e.tokenId] && !camp.tokens[e.tokenId].hidden);
  return { active: i.active, startedAt: i.startedAt, die: initDie(camp), entries };
}

function sendInitiative(camp: Campaign) {
  io.to(gmRoom(camp)).emit("initiative", initiativeFor(camp, "gm"));
  io.to(playerRoom(camp)).emit("initiative", initiativeFor(camp, "player"));
}

function sendInit(socket: Socket, acc: Account, camp: Campaign) {
  socket.emit("init", {
    me: { id: acc.id, name: acc.name, role: acc.role },
    campaign: { name: camp.name },
    map: mapInfo(camp),
    members: membersOf(camp),
    tokens: tokensFor(camp, acc.role),
    messages: camp.messages.filter((m) => canSee(m, acc.id)).slice(-50),
    invites: acc.role === "gm" ? listInvites(camp) : undefined,
    initiative: initiativeFor(camp, acc.role),
    measure: measureOf(camp),
    ...(acc.role === "gm"
      ? { library: camp.library, maps: mapList(camp), activeMapId: camp.activeMapId, tier: tierInfo(camp) }
      : {}),
  });
}

// Delete uploaded files that no map, token or saved token uses any more
function gcAssets(camp: Campaign) {
  const used = new Set<string>();
  for (const m of Object.values(camp.maps)) {
    if (m.image) used.add(m.image);
    if (m.thumb) used.add(m.thumb);
    for (const t of Object.values(m.tokens)) if (t.image) used.add(t.image);
  }
  for (const s of camp.library) if (s.image) used.add(s.image);
  for (const [key, a] of Object.entries(camp.assets)) {
    if (used.has(assetUrl(camp, a.file))) continue;
    delete camp.assets[key];
    fsp.unlink(path.join(UPLOAD_DIR, camp.id, a.file)).catch(() => {});
  }
  save();
}

// After a map shrinks, pull its tokens back inside it (only the open map's changes are sent to players)
function fitTokens(camp: Campaign, m: SceneMap = camp.map) {
  for (const t of Object.values(m.tokens)) {
    const x = clamp(t.x, 0, m.w - t.size * CELL);
    const y = clamp(t.y, 0, m.h - t.size * CELL);
    if (x !== t.x || y !== t.y) {
      t.x = x;
      t.y = y;
      if (m.id === camp.activeMapId) emitToken(camp, "tokenUpdated", t);
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

// ---------- superadmin ----------
const MONTH_CHOICES = [1, 3, 6, 12];
const fmtDate = (t: number) => new Date(t).toLocaleDateString();

// Add whole months, keeping the day of month where possible (31 Jan + 1 month = 28/29 Feb)
function addMonths(ts: number, months: number) {
  const d = new Date(ts);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.getTime();
}

function gmRow(a: Account) {
  const camp = db.campaigns[a.campaignId];
  const rooms = io.sockets.adapter.rooms;
  return {
    id: a.id,
    username: a.username ?? a.name,
    campaign: camp?.name ?? "",
    players: camp?.memberIds.length ?? 0,
    online: camp ? (rooms.get(gmRoom(camp))?.size ?? 0) + (rooms.get(playerRoom(camp))?.size ?? 0) : 0,
    paid: a.paid === true,
    paidUntil: a.paidUntil ?? null,
    tier: a.tier ?? "free",
    maps: camp ? Object.keys(camp.maps).length : 0,
    createdAt: a.createdAt ?? 0,
    lastLoginAt: a.lastLoginAt ?? 0,
    storage: camp ? Object.values(camp.assets).reduce((s, x) => s + x.size, 0) : 0,
  };
}

const allGmRows = () => {
  const gms = Object.values(db.accounts).filter((a) => a.role === "gm");
  gms.forEach((gm) => checkExpiry(gm));
  return gms.map(gmRow);
};

// Everyone connected to this GM's table is told and disconnected
async function lockCampaign(gm: Account) {
  const camp = db.campaigns[gm.campaignId];
  if (!camp) return;
  const sockets = await io.in(everyone(camp)).fetchSockets();
  for (const s of sockets) {
    s.emit("locked", { role: s.data.role ?? "player", campaign: camp.name });
    s.disconnect(true);
  }
}

// Sign the GM out of every open window (their players stay connected)
async function kickGm(camp: Campaign) {
  const sockets = await io.in(gmRoom(camp)).fetchSockets();
  for (const s of sockets) {
    s.emit("unauth");
    s.disconnect(true);
  }
}

// Remove a GM, their table, their players and all uploaded images
async function deleteGm(gm: Account) {
  const camp = db.campaigns[gm.campaignId];
  if (camp) {
    const sockets = await io.in(everyone(camp)).fetchSockets();
    for (const s of sockets) {
      s.emit("unauth");
      s.disconnect(true);
    }
    for (const id of camp.memberIds) delete db.accounts[id];
    delete db.campaigns[camp.id];
    await fsp.rm(path.join(UPLOAD_DIR, camp.id), { recursive: true, force: true }).catch(() => {});
  }
  delete db.accounts[gm.id];
  purgeOrphanSessions();
}

function sendAdminInit(socket: Socket, acc: Account) {
  socket.emit("adminInit", {
    me: { id: acc.id, name: acc.name },
    gms: allGmRows(),
    log: db.log.slice(-300),
    settings: db.settings,
  });
}

function setupAdmin(socket: Socket, acc: Account) {
  socket.join("admin");
  sendAdminInit(socket, acc);

  socket.on("adminList", () => socket.emit("adminGms", allGmRows()));
  socket.on("adminLogList", () => socket.emit("adminLogs", db.log.slice(-500)));

  const findGm = (id: unknown) => {
    const gm = typeof id === "string" ? db.accounts[id] : undefined;
    return gm && gm.role === "gm" ? gm : undefined;
  };

  // Mark paid for 1, 3, 6 or 12 months (months = null: no end date), or mark unpaid
  socket.on("adminSetPaid", async (p: { id?: string; paid?: boolean; months?: number | null }, cb?: Cb) => {
    const gm = findGm(p?.id);
    if (!gm) return cb?.({ error: "GM account not found" });
    if (p.paid === true) {
      const months = p.months === null || p.months === undefined ? null : Number(p.months);
      if (months !== null && !MONTH_CHOICES.includes(months)) return cb?.({ error: "Choose 1, 3, 6 or 12 months" });
      let detail = "No end date";
      if (months === null) {
        gm.paidUntil = undefined;
      } else {
        // Renewing early adds time on top of the current end date; otherwise it starts now
        const base =
          gm.paid === true && gm.paidUntil !== undefined && gm.paidUntil > Date.now() ? gm.paidUntil : Date.now();
        gm.paidUntil = addMonths(base, months);
        detail = `${months} month${months > 1 ? "s" : ""}, until ${fmtDate(gm.paidUntil)}`;
      }
      gm.paid = true;
      save();
      record(acc.name, "gm.paid", gm.username, detail);
    } else {
      gm.paid = false;
      gm.paidUntil = undefined;
      save();
      record(acc.name, "gm.unpaid", gm.username);
      await lockCampaign(gm);
    }
    io.to("admin").emit("adminGm", gmRow(gm));
    cb?.({ ok: true });
  });

  // GM tier: decides the number of maps and the storage
  socket.on("adminSetTier", (p: { id?: string; tier?: string }, cb?: Cb) => {
    const gm = findGm(p?.id);
    if (!gm) return cb?.({ error: "GM account not found" });
    if (!TIERS.includes(p.tier as Tier)) return cb?.({ error: "Unknown tier" });
    const before = gm.tier ?? "free";
    gm.tier = p.tier as Tier;
    save();
    record(acc.name, "gm.tier", gm.username, `${before} -> ${gm.tier}`);
    io.to("admin").emit("adminGm", gmRow(gm));
    const camp = db.campaigns[gm.campaignId];
    if (camp) sendMaps(camp); // the GM sees the new limits at once
    cb?.({ ok: true });
  });

  // Limits of each tier
  socket.on(
    "adminSaveSettings",
    (p: { tiers?: Record<string, { maxMaps?: unknown; storageMb?: unknown }> }, cb?: Cb) => {
      const next = { ...db.settings.tiers };
      for (const t of TIERS) {
        const v = p?.tiers?.[t];
        if (!v) continue;
        const maxMaps = Math.round(Number(v.maxMaps));
        const storageMb = Math.round(Number(v.storageMb));
        if (!(maxMaps >= 1 && maxMaps <= 1000)) return cb?.({ error: `${t}: maps must be between 1 and 1000` });
        if (!(storageMb >= 10 && storageMb <= 100000)) return cb?.({ error: `${t}: storage must be 10 to 100000 MB` });
        next[t] = { maxMaps, storageMb };
      }
      db.settings.tiers = next;
      save();
      record(
        acc.name, "settings.tiers", undefined,
        TIERS.map((t) => `${t}: ${next[t].maxMaps} maps, ${next[t].storageMb} MB`).join(" | ")
      );
      io.to("admin").emit("adminSettings", db.settings);
      for (const c of Object.values(db.campaigns)) sendMaps(c);
      cb?.({ ok: true });
    }
  );

  // New random password, shown to the admin once
  socket.on("adminResetPassword", async (p: { id?: string }, cb?: Cb) => {
    const gm = findGm(p?.id);
    if (!gm) return cb?.({ error: "GM account not found" });
    const temp = randomBytes(9).toString("base64url");
    await setPassword(gm, temp);
    failedLogins.delete(gm.username ?? "");
    const camp = db.campaigns[gm.campaignId];
    if (camp) await kickGm(camp);
    record(acc.name, "gm.password_reset", gm.username);
    cb?.({ ok: true, password: temp });
  });

  socket.on("adminDeleteGm", async (p: { id?: string; confirm?: string }, cb?: Cb) => {
    const gm = findGm(p?.id);
    if (!gm) return cb?.({ error: "GM account not found" });
    if (String(p.confirm ?? "").trim().toLowerCase() !== gm.username) {
      return cb?.({ error: "The typed username does not match" });
    }
    const players = db.campaigns[gm.campaignId]?.memberIds.length ?? 0;
    await deleteGm(gm);
    record(acc.name, "gm.deleted", gm.username, `Table and ${players} player account(s) removed`);
    io.to("admin").emit("adminGmRemoved", gm.id);
    cb?.({ ok: true });
  });
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
    const camp = acc && acc.role === "gm" ? db.campaigns[acc.campaignId] : undefined;
    if (!acc || !camp) return void res.status(403).json({ error: "Only the GM can upload images" });
    if (!isActive(camp)) return void res.status(403).json({ error: "Your account is not active" });
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: "Empty upload" });

    const kind = String(req.query.kind);
    if (kind !== "map" && kind !== "token" && kind !== "thumb") {
      return void res.status(400).json({ error: "Unknown upload type" });
    }
    const ext = sniff(body);
    if (!ext) return void res.status(415).json({ error: "Use a PNG, JPG or WebP image" });
    const maxBytes = kind === "map" ? MAX_MAP_BYTES : kind === "thumb" ? MAX_THUMB_BYTES : MAX_TOKEN_BYTES;
    if (body.length > maxBytes) return void res.status(413).json({ error: "Image is too large" });

    const tok = kind === "token" ? camp.tokens[String(req.query.tokenId)] : undefined;
    if (kind === "token" && !tok) return void res.status(404).json({ error: "Token not found" });
    // Map pictures and previews can be set for any map (default: the open one)
    const mapId = req.query.mapId === undefined ? camp.activeMapId : String(req.query.mapId);
    const target = kind === "map" || kind === "thumb" ? camp.maps[mapId] : undefined;
    if ((kind === "map" || kind === "thumb") && !target) return void res.status(404).json({ error: "Map not found" });

    // Storage limit of the GM's tier (the image being replaced does not count)
    const quotaMb = tierSetting(acc).storageMb;
    const replacedUrl = kind === "map" ? target?.image : kind === "thumb" ? target?.thumb : tok?.image;
    const used = Object.values(camp.assets).reduce(
      (sum, a) => sum + (replacedUrl === assetUrl(camp, a.file) ? 0 : a.size),
      0
    );
    if (used + body.length > quotaMb * 1024 * 1024) {
      return void res.status(413).json({ error: `Storage full (${quotaMb} MB). Remove some images or ask for a higher tier.` });
    }

    const file = `${randomBytes(16).toString("hex")}.${ext}`;
    await fsp.mkdir(path.join(UPLOAD_DIR, camp.id), { recursive: true });
    await fsp.writeFile(path.join(UPLOAD_DIR, camp.id, file), body);
    camp.assets[file] = { file, size: body.length };
    const url = assetUrl(camp, file);

    if (kind === "map" && target) {
      target.image = url;
      target.thumb = undefined; // the GM's browser makes a new preview
      target.w = clamp(Math.round(Number(req.query.w)) || 2000, MIN_MAP, MAX_MAP);
      target.h = clamp(Math.round(Number(req.query.h)) || 2000, MIN_MAP, MAX_MAP);
      fitTokens(camp, target);
      if (target.id === camp.activeMapId) io.to(everyone(camp)).emit("map", mapInfo(camp));
    } else if (kind === "thumb" && target) {
      target.thumb = url;
    } else if (tok) {
      tok.image = url;
      syncLibrary(camp, tok);
      emitToken(camp, "tokenUpdated", tok);
    }
    gcAssets(camp);
    sendMaps(camp);
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

type Patch = {
  id: string; label?: string; color?: string; size?: number; ownerId?: string | null;
  hp?: number; maxHp?: number; hidden?: boolean;
};

io.on("connection", (socket) => {
  const session = socket.handshake.auth?.session;
  const acc0 = accountFromSession(session);
  const camp0 = acc0 && acc0.role !== "admin" ? db.campaigns[acc0.campaignId] : undefined;

  // ---------- available before signing in ----------
  socket.on("register", async (p: { username?: string; password?: string; campaignName?: string }, cb?: Cb) => {
    if (typeof cb !== "function") return;
    if (!allow(socket, "auth", 5, 60_000)) return cb({ error: "Too many attempts, wait a minute" });
    const res = await createGm(String(p?.username ?? ""), String(p?.password ?? ""), String(p?.campaignName ?? ""));
    if ("error" in res) return cb({ error: res.error });
    res.account.lastLoginAt = Date.now();
    record(res.account.name, "gm.registered", res.account.name, `Table: ${db.campaigns[res.account.campaignId]?.name ?? ""}`);
    io.to("admin").emit("adminGm", gmRow(res.account));
    cb({ ok: true, session: newSession(res.account.id) });
  });

  socket.on("login", async (p: { username?: string; password?: string }, cb?: Cb) => {
    if (typeof cb !== "function") return;
    if (!allow(socket, "auth", 5, 60_000)) return cb({ error: "Too many attempts, wait a minute" });
    const uname = String(p?.username ?? "").trim().toLowerCase();
    if (recentFails(uname) >= FAIL_LIMIT) {
      return cb({ error: "Too many failed attempts for this account. Try again in 15 minutes." });
    }
    const found = await checkLogin(uname, String(p?.password ?? ""));
    if (!found) {
      noteFail(uname);
      if (recentFails(uname) === FAIL_LIMIT) {
        record("system", "login.lockout", uname, "Too many failed sign-ins: blocked for 15 minutes");
      }
      return cb({ error: "Wrong username or password" });
    }
    failedLogins.delete(uname);
    found.lastLoginAt = Date.now();
    if (found.role === "admin") record(found.name, "admin.login");
    save();
    cb({ ok: true, session: newSession(found.id) });
  });

    socket.on("join", (p: { code?: string; name?: string; session?: string; playerId?: string }, cb?: Cb) => {
    if (typeof cb !== "function") return;
    if (!allow(socket, "join", 10, 60_000)) return cb({ error: "Too many attempts, wait a minute" });
    // A full link still lets players who already joined come back; only new players need a free place
    const found = findInvite(p?.code, true);
    if (!found) return cb({ error: "This invite link is invalid or has expired" });
    const { camp, inv } = found;

    const existing = accountFromSession(p?.session);
    if (existing && existing.campaignId === camp.id) return cb({ ok: true, session: p.session });

    if (!isActive(camp)) return cb({ error: "This table is not active right now. Please ask your GM." });

    const canCreate = inv.uses < inv.maxUses && camp.memberIds.length < 20;

    // Come back as a player who already joined this table (no new account, no new link use)
    if (typeof p?.playerId === "string") {
      const player = camp.memberIds.includes(p.playerId) ? db.accounts[p.playerId] : undefined;
      if (!player) return cb({ error: "That name is not at this table any more" });
      postMsg(camp, player, {
        to: [camp.gmId], kind: "action", text: `${player.name} signed in again with an existing name`,
      });
      return cb({ ok: true, session: newSession(player.id) });
    }

    const name = String(p?.name ?? "").trim().slice(0, 20);
    if (!name) {
      // First step: tell the browser who is at this table so one of them can be picked
      const rooms = io.sockets.adapter.rooms;
      return cb({
        needName: true,
        campaign: camp.name,
        canCreate,
        players: camp.memberIds
          .map((id) => db.accounts[id])
          .filter(Boolean)
          .map((a) => ({ id: a.id, name: a.name, online: (rooms.get(acctRoom(a.id))?.size ?? 0) > 0 })),
      });
    }
    if (!canCreate) {
      return cb({ error: "This invite link is full. Pick your name from the list, or ask your GM for a new link." });
    }
    if (camp.memberIds.some((id) => db.accounts[id]?.name.toLowerCase() === name.toLowerCase())) {
      return cb({ error: "That name is already used at this table. If it is you, pick it from the list." });
    }

    // New player: no token is made, the GM creates and assigns it
    inv.uses += 1;
    const player = createPlayer(camp, name);
    (inv.usedBy ??= []).push({ id: player.id, name: player.name, ts: Date.now() });
    save();
    io.to(everyone(camp)).emit("members", membersOf(camp));
    io.to(gmRoom(camp)).emit("invites", listInvites(camp));
    postMsg(camp, player, { to: [camp.gmId], kind: "action", text: `${player.name} joined the table (no token yet)` });
    cb({ ok: true, session: newSession(player.id) });
  });

  socket.on("logout", (cb?: () => void) => {
    endSession(session);
    cb?.();
  });

  socket.on("hello", () => {
    if (acc0?.role === "admin") sendAdminInit(socket, acc0);
    else if (acc0 && camp0) {
      if (isActive(camp0)) sendInit(socket, acc0, camp0);
      else socket.emit("locked", { role: acc0.role, campaign: camp0.name });
    } else socket.emit("unauth");
  });

  // ---------- who is this? ----------
  if (acc0?.role === "admin") {
    setupAdmin(socket, acc0);
    return;
  }
  if (!acc0 || !camp0) {
    socket.emit("unauth");
    return;
  }
  if (!isActive(camp0)) {
    socket.emit("locked", { role: acc0.role, campaign: camp0.name });
    return;
  }

  // ---------- signed in and active ----------
  const acc = acc0;
  const camp = camp0;
  const isGm = acc.role === "gm";
  socket.data.role = acc.role;
  socket.join([acctRoom(acc.id), isGm ? gmRoom(camp) : playerRoom(camp)]);
  sendInit(socket, acc, camp);

  // GM: change own password (the current session stays valid, other devices are signed out)
  socket.on("changePassword", async (p: { current?: string; next?: string }, cb?: Cb) => {
    if (!isGm || typeof cb !== "function") return;
    if (!allow(socket, "pw", 5, 60_000)) return cb({ error: "Too many attempts, wait a minute" });
    const next = String(p?.next ?? "");
    if (next.length < 8 || next.length > 100) return cb({ error: "New password must be 8-100 characters" });
    const ok = await checkLogin(acc.username ?? "", String(p?.current ?? ""));
    if (!ok || ok.id !== acc.id) return cb({ error: "Current password is wrong" });
    await setPassword(acc, next);
    record(acc.name, "gm.password_changed", acc.username);
    cb({ ok: true, session: newSession(acc.id) });
  });

  // GM: invite links
  socket.on("createInvite", (p: { hours?: number; maxUses?: number }, cb?: Cb) => {
    if (!isGm) return;
    const hours = clamp(Number(p?.hours) || 24, 1, 168);
    const maxUses = clamp(Math.round(Number(p?.maxUses) || 6), 1, 20);
    if (activeInvites(camp).length >= 10) return cb?.({ error: "Too many active links. Revoke one first." });
    camp.invites.push({ code: randomBytes(9).toString("base64url"), expiresAt: Date.now() + hours * 3_600_000, maxUses, uses: 0 });
    save();
    io.to(gmRoom(camp)).emit("invites", listInvites(camp));
    cb?.({ ok: true });
  });

  socket.on("revokeInvite", (code: string) => {
    if (!isGm) return;
    camp.invites = camp.invites.filter((i) => i.code !== code);
    save();
    io.to(gmRoom(camp)).emit("invites", listInvites(camp));
  });

  // GM: remove a player. Their tokens stay on the maps and go back to the GM.
  socket.on("removePlayer", async (p: { id?: string }) => {
    if (!isGm || typeof p?.id !== "string" || !camp.memberIds.includes(p.id)) return;
    const id = p.id;
    const playerName = db.accounts[id]?.name ?? "?";
    camp.memberIds = camp.memberIds.filter((m) => m !== id);
    // Tokens on every map, and saved tokens, go back to the GM
    for (const m of Object.values(camp.maps)) {
      for (const t of Object.values(m.tokens)) {
        if (t.ownerId !== id) continue;
        t.ownerId = null;
        if (m.id === camp.activeMapId) emitToken(camp, "tokenUpdated", t); // players now see it as a GM token
      }
    }
    for (const s of camp.library) if (s.ownerId === id) s.ownerId = null;
    delete db.accounts[id];
    purgeOrphanSessions();
    save();
    // Sign the player out of every open window
    const sockets = await io.in(acctRoom(id)).fetchSockets();
    for (const s of sockets) {
      s.emit("unauth");
      s.disconnect(true);
    }
    io.to(everyone(camp)).emit("members", membersOf(camp));
    io.to(gmRoom(camp)).emit("library", camp.library);
    record(acc.name, "player.removed", acc.name, `Removed player ${playerName}`);
  });

    // GM: size of a map (the open one if no id is given)
  socket.on("setMap", (p: { id?: string; w?: number; h?: number }) => {
    const m = p && typeof p.id === "string" ? camp.maps[p.id] : camp.map;
    if (!isGm || !p || !m) return;
    m.w = clamp(Math.round(Number(p.w)) || m.w, MIN_MAP, MAX_MAP);
    m.h = clamp(Math.round(Number(p.h)) || m.h, MIN_MAP, MAX_MAP);
    fitTokens(camp, m);
    save();
    if (m.id === camp.activeMapId) io.to(everyone(camp)).emit("map", mapInfo(camp));
    sendMaps(camp);
  });

  // GM: remove the picture of a map (the open one if no id is given)
  socket.on("clearMap", (id?: string) => {
    const m = typeof id === "string" ? camp.maps[id] : camp.map;
    if (!isGm || !m) return;
    m.image = undefined;
    m.thumb = undefined;
    gcAssets(camp);
    if (m.id === camp.activeMapId) io.to(everyone(camp)).emit("map", mapInfo(camp));
    sendMaps(camp);
  });

  // GM: the library of maps
  socket.on("createMap", (p: { name?: string }, cb?: Cb) => {
    if (!isGm) return;
    const limit = tierSetting(acc).maxMaps;
    const count = Object.keys(camp.maps).length;
    if (count >= limit) {
      return cb?.({ error: `Your tier allows ${limit} maps. Delete a map or ask the administrator for a higher tier.` });
    }
    const id = randomUUID();
    camp.maps[id] = { id, name: cleanName(p?.name, `Map ${count + 1}`), w: 2000, h: 2000, tokens: {}, createdAt: Date.now() };
    save();
    sendMaps(camp);
    cb?.({ ok: true });
  });

  socket.on("renameMap", (p: { id?: string; name?: string }) => {
    const m = typeof p?.id === "string" ? camp.maps[p.id] : undefined;
    if (!isGm || !m) return;
    m.name = cleanName(p.name, m.name);
    save();
    sendMaps(camp);
    if (m.id === camp.activeMapId) io.to(everyone(camp)).emit("map", mapInfo(camp));
  });

  socket.on("deleteMap", (id: string, cb?: Cb) => {
    const m = typeof id === "string" ? camp.maps[id] : undefined;
    if (!isGm || !m) return;
    if (m.id === camp.activeMapId) return cb?.({ error: "Open another map first, then delete this one." });
    if (Object.keys(camp.maps).length <= 1) return cb?.({ error: "You need at least one map." });
    delete camp.maps[id];
    gcAssets(camp);
    sendMaps(camp);
    cb?.({ ok: true });
  });

  // Everyone switches to this map
  socket.on("activateMap", (id: string) => {
    if (!isGm || typeof id !== "string" || !camp.maps[id] || id === camp.activeMapId) return;
    camp.activeMapId = id;
    save();
    broadcastScene(camp);
    sendMaps(camp);
  });

  // GM: the library of saved tokens
  socket.on("saveToken", (p: { id?: string }, cb?: Cb) => {
    const t = typeof p?.id === "string" ? camp.tokens[p.id] : undefined;
    if (!isGm || !t) return cb?.({ error: "Token not found" });
    if (!saveToLibrary(camp, t)) return cb?.({ error: `The library is full (${MAX_LIBRARY} tokens)` });
    cb?.({ ok: true });
  });

  // Place a copy of a saved token on the open map (full HP, visible)
  socket.on("libraryAdd", (p: { id?: string; x?: number; y?: number }) => {
    const s = camp.library.find((x) => x.id === p?.id);
    if (!isGm || !s) return;
    const count = Object.keys(camp.tokens).length;
    if (count >= MAX_TOKENS) return;
    const id = randomUUID();
    const pos = 20 + (count % 10) * 30;
    const hasPos = typeof p.x === "number" && typeof p.y === "number";
    camp.tokens[id] = clean(
      {
        label: s.label, color: s.color, size: s.size, maxHp: s.maxHp, hp: s.maxHp,
        image: s.image, rot: s.rot, flip: s.flip, ownerId: s.ownerId ?? null,
        x: hasPos ? p.x : pos, y: hasPos ? p.y : pos, z: nextZ(camp),
      },
      id, camp
    );
    save();
    emitToken(camp, "tokenAdded", camp.tokens[id]);
  });

  socket.on("libraryDelete", (id: string) => {
    if (!isGm) return;
    camp.library = camp.library.filter((s) => s.id !== id);
    gcAssets(camp);
    io.to(gmRoom(camp)).emit("library", camp.library);
    sendMaps(camp);
  });

  // GM: tokens
    socket.on("addToken", (raw: Partial<Token> & { save?: boolean }) => {
    if (!isGm || !raw || typeof raw !== "object") return;
    const count = Object.keys(camp.tokens).length;
    if (count >= MAX_TOKENS) return;
    const id = randomUUID();
    const pos = 20 + (count % 10) * 30;
    const hasPos = typeof raw.x === "number" && typeof raw.y === "number";
    camp.tokens[id] = clean(
      { ...raw, x: hasPos ? raw.x : pos, y: hasPos ? raw.y : pos, z: nextZ(camp) },
      id, camp
    );
    if (raw.save === true) saveToLibrary(camp, camp.tokens[id]); // also keep it in the library
    save();
    emitToken(camp, "tokenAdded", camp.tokens[id]);
  });

  socket.on("updateToken", (p: Patch) => {
    if (!isGm || !p) return;
    const cur = camp.tokens[p.id];
    if (!cur) return;
    const wasHidden = !!cur.hidden;
    const next = clean(
      {
        ...cur,
        label: p.label ?? cur.label,
        color: p.color ?? cur.color,
        size: p.size ?? cur.size,
        ownerId: p.ownerId === undefined ? cur.ownerId : p.ownerId,
        hp: p.hp ?? cur.hp,
        maxHp: p.maxHp ?? cur.maxHp,
        hidden: p.hidden ?? cur.hidden,
      },
      cur.id, camp
    );
    camp.tokens[cur.id] = next;
    syncLibrary(camp, next);
    save();
    if (!wasHidden && next.hidden) {
      // Hiding: players lose the token completely
      io.to(gmRoom(camp)).emit("tokenUpdated", next);
      io.to(playerRoom(camp)).emit("tokenRemoved", next.id);
    } else if (wasHidden && !next.hidden) {
      // Revealing: players receive it as a new token
      io.to(gmRoom(camp)).emit("tokenUpdated", next);
      io.to(playerRoom(camp)).emit("tokenAdded", forPlayers(next));
    } else {
      emitToken(camp, "tokenUpdated", next);
    }
    if (wasHidden !== !!next.hidden) sendInitiative(camp); // players gain or lose that token's entry
  });

  socket.on("clearTokenImage", (id: string) => {
    if (!isGm) return;
    const t = camp.tokens[id];
    if (!t) return;
    t.image = undefined;
    syncLibrary(camp, t);
    gcAssets(camp);
    emitToken(camp, "tokenUpdated", t);
  });

  // Rotate / flip the picture: the GM for any token, a player for their own
  socket.on("setLook", (p: { id: string; rot?: number; flip?: boolean }) => {
    const t = camp.tokens[p?.id];
    if (!t || (!isGm && (t.ownerId !== acc.id || t.hidden))) return;
    if (p.rot !== undefined) t.rot = (((Math.round(Number(p.rot)) || 0) % 360) + 360) % 360;
   if (p.flip !== undefined) t.flip = p.flip === true;
    if (isGm) syncLibrary(camp, t);
    save();
    emitToken(camp, "tokenUpdated", t);
  });

  // GM: change the layer order of tokens
  socket.on("reorder", (p: { id: string; op: "front" | "back" | "up" | "down" }) => {
    if (!isGm || !p) return;
    const list = Object.values(camp.tokens).sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
    const i = list.findIndex((t) => t.id === p.id);
    if (i < 0) return;
    const [t] = list.splice(i, 1);
    const j =
      p.op === "front" ? list.length
      : p.op === "back" ? 0
      : p.op === "up" ? Math.min(i + 1, list.length)
      : Math.max(i - 1, 0);
    list.splice(j, 0, t);
    list.forEach((tok, idx) => {
      if ((tok.z ?? 0) !== idx) {
        tok.z = idx;
        emitToken(camp, "tokenUpdated", tok);
      }
    });
    save();
  });

  socket.on("removeToken", (id: string) => {
    if (!isGm || !camp.tokens[id]) return;
    delete camp.tokens[id];
    const init = initOf(camp);
    init.entries = init.entries.filter((e) => e.tokenId !== id);
    gcAssets(camp);
    io.to(everyone(camp)).emit("tokenRemoved", id);
    sendInitiative(camp);
  });

  // Players: only their own token
  socket.on("setHp", ({ id, hp }: { id: string; hp: number }) => {
    const t = camp.tokens[id];
    if (!t || (!isGm && (t.ownerId !== acc.id || t.hidden))) return;
    t.hp = clamp(Math.round(Number(hp) || 0), 0, t.maxHp);
    save();
    emitToken(camp, "tokenUpdated", t);
  });

  socket.on("move", ({ id, x, y }: { id: string; x: number; y: number }) => {
    const t = camp.tokens[id];
    if (!t || (!isGm && (t.ownerId !== acc.id || t.hidden))) return;
    t.x = clamp(Number(x) || 0, 0, camp.map.w - t.size * CELL);
    t.y = clamp(Number(y) || 0, 0, camp.map.h - t.size * CELL);
    save();
    // Moves of hidden tokens are only sent to the GM
    socket.to(t.hidden ? [gmRoom(camp)] : everyone(camp)).emit("moved", { id, x: t.x, y: t.y });
  });

  // A token uses an action on another token.
  // Melee Attack: the token glides to the target. Ranged Attack: a temporary ammo token flies to the target.
  socket.on("tokenAction", (p: { from?: string; to?: string; action?: string; ammo?: string }) => {
    if (!allow(socket, "act", 10, 10_000)) return;
    const label = p?.action ? ACTION_LABELS[p.action] : undefined;
    const src = typeof p?.from === "string" ? camp.tokens[p.from] : undefined;
    const dst = typeof p?.to === "string" ? camp.tokens[p.to] : undefined;
    if (!label || !src || !dst || src.id === dst.id) return;
    // The GM may use any token. A player: only their own, and only against tokens they can see.
    if (!isGm && (src.ownerId !== acc.id || src.hidden || dst.hidden)) return;

    // If a hidden token is involved, only the GM sees the move or shot and the chat line
    const secret = !!src.hidden || !!dst.hidden;
    const rooms = secret ? [gmRoom(camp)] : everyone(camp);

    const sSize = src.size * CELL;
    const dSize = dst.size * CELL;
    const sc = { x: src.x + sSize / 2, y: src.y + sSize / 2 };
    const dc = { x: dst.x + dSize / 2, y: dst.y + dSize / 2 };
    const dist = Math.hypot(dc.x - sc.x, dc.y - sc.y);

    if (p.action === "bow") {
      // Ranged Attack: the shooter stays. A shot flies from its edge to the edge of the target.
      const ammo = typeof p.ammo === "string" && AMMO.includes(p.ammo) ? p.ammo : null;
      if (!ammo) return;
      const d = dist || 1;
      const ux = (dc.x - sc.x) / d;
      const uy = (dc.y - sc.y) / d;
      const out = sSize / 2; // leaves from the edge of the shooter
      const hit = RANGED_HIT_CENTER ? 0 : dSize / 2; // ends where it touches the target
      let sx = sc.x + ux * out;
      let sy = sc.y + uy * out;
      let ex = dc.x - ux * hit;
      let ey = dc.y - uy * hit;
      if (dist - out - hit < 8) {
        // Tokens are touching: a very short shot from center to center
        sx = sc.x;
        sy = sc.y;
        ex = dc.x;
        ey = dc.y;
      }
      const flight = Math.hypot(ex - sx, ey - sy);
      const ms = Math.round(clamp(flight / 1.6, 160, 500)); // fast: about 1600 px per second
      io.to(rooms).emit("projectile", {
        id: randomUUID(), ammo, sx, sy, ex, ey,
        angle: (Math.atan2(dc.y - sc.y, dc.x - sc.x) * 180) / Math.PI, // direction in degrees, 0 = right
        ms,
      });
      io.to(rooms).emit("hit", { id: dst.id, delay: ms }); // the target shakes when the shot lands
    } else {
      // Melee Attack: straight line until the edges touch
      let goal = dc;
      if (MELEE_STOP_AT_CONTACT) {
        const contact = (sSize + dSize) / 2;
        goal = dist <= contact
          ? sc // already touching: stay
          : { x: dc.x - ((dc.x - sc.x) / dist) * contact, y: dc.y - ((dc.y - sc.y) / dist) * contact };
      }
      const x = clamp(goal.x - sSize / 2, 0, camp.map.w - sSize);
      const y = clamp(goal.y - sSize / 2, 0, camp.map.h - sSize);
      const moved = Math.hypot(x - src.x, y - src.y);
      const ms = Math.round(clamp(350 + moved * 1.2, 400, 1500));
      src.x = x;
      src.y = y;
      save();
      if (moved >= 1) io.to(rooms).emit("tween", { id: src.id, x, y, ms });
      io.to(rooms).emit("hit", { id: dst.id, delay: moved >= 1 ? ms : 0 }); // the target shakes when the attacker arrives
    }

    postMsg(camp, acc, {
      to: secret ? [camp.gmId] : null,
      kind: "action",
      text: `${src.label} use ${label} to ${dst.label}`,
    });
  });
  
    // ---------- initiative ----------
  // GM: start. Every token of the open map goes into the list and the players are asked to roll.
  socket.on("initiativeStart", () => {
    if (!isGm) return;
    const init = initOf(camp);
    init.active = true;
    init.startedAt = Date.now();
    init.entries = Object.values(camp.tokens).map((t) => ({ tokenId: t.id, value: null }));
    save();
    sendInitiative(camp);
  });

  // GM: end. The list is cleared.
  socket.on("initiativeEnd", () => {
    if (!isGm) return;
    const init = initOf(camp);
    init.active = false;
    init.entries = [];
    save();
    sendInitiative(camp);
  });

  // GM: type a value by hand (null = no value yet)
  socket.on("initiativeSet", (p: { tokenId?: string; value?: number | null }) => {
    if (!isGm || !p) return;
    const entry = initOf(camp).entries.find((e) => e.tokenId === p.tokenId);
    if (!entry) return;
    if (p.value === null || p.value === undefined) {
      entry.value = null;
    } else {
      const v = Math.round(Number(p.value));
      if (!Number.isFinite(v)) return;
      entry.value = clamp(v, -99, 999);
    }
    save();
    sendInitiative(camp);
  });

  // GM: add or remove a token by hand
  socket.on("initiativeAdd", (p: { tokenId?: string }) => {
    const init = initOf(camp);
    if (!isGm || !init.active || typeof p?.tokenId !== "string" || !camp.tokens[p.tokenId]) return;
    if (init.entries.some((e) => e.tokenId === p.tokenId)) return;
    init.entries.push({ tokenId: p.tokenId, value: null });
    save();
    sendInitiative(camp);
  });

  socket.on("initiativeRemove", (p: { tokenId?: string }) => {
    if (!isGm || !p) return;
    const init = initOf(camp);
    init.entries = init.entries.filter((e) => e.tokenId !== p.tokenId);
    save();
    sendInitiative(camp);
  });

  // Roll initiative for a token. The GM can roll for any token (again too); a player once, for their own.
  socket.on("initiativeRoll", (p: { tokenId?: string }) => {
    if (!allow(socket, "init", 20, 10_000)) return;
    const init = initOf(camp);
    const t = typeof p?.tokenId === "string" ? camp.tokens[p.tokenId] : undefined;
    const entry = t ? init.entries.find((e) => e.tokenId === t.id) : undefined;
    if (!init.active || !t || !entry) return;
    if (!isGm && (t.ownerId !== acc.id || t.hidden || entry.value !== null)) return;
    const sides = initDie(camp);
    const value = 1 + Math.floor(Math.random() * sides);
    entry.value = value;
    save();
    // Shown like any dice roll (3D dice and result popup), under the token's name; secret for a hidden token
    postMsg(camp, acc, {
      to: t.hidden ? [camp.gmId] : null,
      kind: "roll",
      as: t.label,
      roll: { formula: `initiative (d${sides})`, rolls: [value], sides, keep: [true], total: value },
    });
    sendInitiative(camp);
  });

  // GM: the dice used for initiative
  socket.on("setInitiativeDie", (die: number) => {
    if (!isGm || ![6, 10, 20].includes(die)) return;
    camp.initiativeDie = die;
    save();
    sendInitiative(camp);
  });

    // GM: feet per square and the four range bands used by the rulers
  socket.on("setMeasure", (p: Partial<Record<keyof Measure, unknown>>, cb?: Cb) => {
    if (!isGm || !p) return;
    const n = (v: unknown) => Math.round(Number(v));
    const m: Measure = {
      ftPerSquare: n(p.ftPerSquare), melee: n(p.melee), veryClose: n(p.veryClose), close: n(p.close), far: n(p.far),
    };
    if (!(m.ftPerSquare >= 1 && m.ftPerSquare <= 100)) return cb?.({ error: "Feet per square must be 1 to 100" });
    if (!(m.melee >= 1 && m.melee < m.veryClose && m.veryClose < m.close && m.close < m.far && m.far <= 10000)) {
      return cb?.({ error: "Ranges must grow: Melee, then Very close, then Close, then Far (in feet)" });
    }
    camp.measure = m;
    save();
    io.to(everyone(camp)).emit("measure", m);
    cb?.({ ok: true });
  });
  
  // GM: clear the chat for everyone
  socket.on("clearChat", () => {
    if (!isGm) return;
    camp.messages = [];
    save();
    io.to(everyone(camp)).emit("chatCleared");
    postMsg(camp, acc, { to: null, kind: "action", text: "The GM cleared the chat" });
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

loadDb().then(async () => {
  const user = process.env.SUPERADMIN_USER;
  const pass = process.env.SUPERADMIN_PASSWORD;
  if (user && pass) {
    const r = await ensureAdmin(user, pass);
    console.log(r.error ? `Superadmin NOT created: ${r.error}` : `Superadmin ready: ${user}`);
  } else {
    console.log("No SUPERADMIN_USER / SUPERADMIN_PASSWORD set: the admin area is disabled");
  }
  // Every minute: switch off GMs whose paid period has ended, even if they are online
  setInterval(() => {
    for (const gm of Object.values(db.accounts)) {
      if (checkExpiry(gm)) void lockCampaign(gm);
    }
  }, 60_000);
  httpServer.listen(3001, () => {
    console.log("Server on http://localhost:3001");
    console.log("Open http://localhost:5173/ to sign in");
  });
});