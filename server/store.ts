import { promises as fs } from "fs";
import path from "path";
import { randomBytes, createHash, scrypt, timingSafeEqual, randomUUID } from "crypto";

export type Role = "gm" | "player" | "admin";
export type Tier = "free" | "basic" | "pro" | "master";
export const TIERS: Tier[] = ["free", "basic", "pro", "master"];
export type TierSetting = { maxMaps: number; storageMb: number };
export const DEFAULT_TIERS: Record<Tier, TierSetting> = {
  free: { maxMaps: 5, storageMb: 50 },
  basic: { maxMaps: 20, storageMb: 200 },
  pro: { maxMaps: 50, storageMb: 500 },
  master: { maxMaps: 100, storageMb: 1000 },
};

export type Account = {
  id: string; name: string; role: Role; campaignId: string;
  username?: string; salt?: string; hash?: string; // GM and admin accounts have a password
  paid?: boolean; // GM accounts only: false = cannot use the site
  paidUntil?: number; // GM accounts: access ends at this time (empty = no end date)
  tier?: Tier; // GM accounts: decides how many maps and how much storage
  createdAt?: number; lastLoginAt?: number;
};
export type Token = {
  id: string; x: number; y: number; color: string; label: string;
  size: number; ownerId: string | null; hp: number; maxHp: number; image?: string;
  rot?: number; flip?: boolean; hidden?: boolean; z?: number;
};
export type Roll = { formula: string; rolls: number[]; sides: number; total: number; keep?: boolean[] };
export type Msg = {
  id: string; ts: number; fromId: string; fromName: string;
  to: string[] | null; kind: "text" | "roll" | "action"; text?: string; roll?: Roll;
};
export type Invite = {
  code: string; expiresAt: number; maxUses: number; uses: number;
  usedBy?: { id: string; name: string; ts: number }[];
};
export type Asset = { file: string; size: number };

// One map with its own tokens
export type SceneMap = {
  id: string; name: string; image?: string; thumb?: string; w: number; h: number;
  tokens: Record<string, Token>; createdAt: number;
};

// A token kept in the GM's library. It can be placed on any map.
export type SavedToken = {
  id: string; label: string; color: string; size: number; maxHp: number;
  image?: string; rot?: number; flip?: boolean; ownerId?: string | null; savedAt: number;
  fromTokenId?: string; // the map token this entry was made from and stays in step with
};

export type Campaign = {
  id: string; name: string; gmId: string; memberIds: string[];
  messages: Msg[]; invites: Invite[]; assets: Record<string, Asset>;
  maps: Record<string, SceneMap>; activeMapId: string; library: SavedToken[];
  // The open map and its tokens: always the active map. Set up by bindCampaign, never saved on their own.
  readonly map: SceneMap;
  readonly tokens: Record<string, Token>;
};
export type LogEntry = { id: string; ts: number; actor: string; action: string; target?: string; detail?: string };
type DB = {
  accounts: Record<string, Account>;
  sessions: Record<string, { accountId: string; expiresAt: number }>;
  campaigns: Record<string, Campaign>;
  log: LogEntry[];
  settings: { tiers: Record<Tier, TierSetting> };
};

const FILE = path.join(process.cwd(), "data.json");
export const db: DB = {
  accounts: {}, sessions: {}, campaigns: {}, log: [],
  settings: { tiers: { ...DEFAULT_TIERS } },
};

// campaign.map and campaign.tokens always point at the open map, so the rest of the server code
// keeps working on "the map in play". They are not enumerable, so they are not saved twice.
export function bindCampaign(c: Campaign) {
  Object.defineProperty(c, "map", { get: () => c.maps[c.activeMapId], enumerable: false, configurable: true });
  Object.defineProperty(c, "tokens", {
    get: () => c.maps[c.activeMapId].tokens, enumerable: false, configurable: true,
  });
}

export const tierSetting = (gm?: Account): TierSetting =>
  db.settings.tiers[gm?.tier ?? "free"] ?? DEFAULT_TIERS.free;

export async function loadDb() {
  try {
    Object.assign(db, JSON.parse(await fs.readFile(FILE, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Cannot read data.json, fix or remove it:", e);
      process.exit(1);
    }
  }
  db.log ??= [];
  db.settings ??= { tiers: { ...DEFAULT_TIERS } };
  db.settings.tiers ??= { ...DEFAULT_TIERS };
  for (const t of TIERS) db.settings.tiers[t] = { ...DEFAULT_TIERS[t], ...db.settings.tiers[t] };

  const now = Date.now();
  for (const [k, s] of Object.entries(db.sessions)) if (s.expiresAt < now) delete db.sessions[k];

  for (const c of Object.values(db.campaigns)) {
    // Older data kept one map and its tokens directly on the campaign: that becomes "Map 1"
    const old = c as unknown as { map?: { image?: string; w?: number; h?: number }; tokens?: Record<string, Token> };
    if (!c.maps || Object.keys(c.maps).length === 0) {
      const id = randomUUID();
      c.maps = {
        [id]: {
          id, name: "Map 1", image: old.map?.image, w: old.map?.w ?? 2000, h: old.map?.h ?? 2000,
          tokens: old.tokens ?? {}, createdAt: now,
        },
      };
      c.activeMapId = id;
    }
    if (!c.maps[c.activeMapId]) c.activeMapId = Object.keys(c.maps)[0];
    delete old.map;
    delete old.tokens;
    c.library ??= [];
    c.assets ??= {};
    bindCampaign(c);
  }

  // GM accounts created before the paid flag and tiers existed keep their access, on the Free tier
  for (const a of Object.values(db.accounts)) {
    if (a.role === "gm") {
      a.paid ??= true;
      a.createdAt ??= now;
      a.tier ??= "free";
    }
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
export function save() {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    try {
      await fs.writeFile(FILE + ".tmp", JSON.stringify(db));
      await fs.rename(FILE + ".tmp", FILE);
    } catch (e) {
      console.error("save failed", e);
    }
  }, 300);
}

// ---------- activity log ----------
export function logEvent(actor: string, action: string, target?: string, detail?: string): LogEntry {
  const entry: LogEntry = { id: randomUUID(), ts: Date.now(), actor, action, target, detail };
  db.log.push(entry);
  if (db.log.length > 2000) db.log.splice(0, db.log.length - 2000);
  save();
  return entry;
}

// ---------- sessions and passwords ----------
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const derive = (pw: string, salt: string) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));

export function newSession(accountId: string) {
  const token = randomBytes(32).toString("hex");
  db.sessions[sha(token)] = { accountId, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 };
  save();
  return token;
}

function dropSessionsOf(accountId: string) {
  for (const [k, s] of Object.entries(db.sessions)) if (s.accountId === accountId) delete db.sessions[k];
}

// After accounts are deleted, remove sessions that point to nobody
export function purgeOrphanSessions() {
  for (const [k, s] of Object.entries(db.sessions)) if (!db.accounts[s.accountId]) delete db.sessions[k];
  save();
}

export function accountFromSession(token: unknown): Account | null {
  if (typeof token !== "string" || !token) return null;
  const s = db.sessions[sha(token)];
  if (!s || s.expiresAt < Date.now()) return null;
  return db.accounts[s.accountId] ?? null;
}

export function endSession(token: unknown) {
  if (typeof token !== "string") return;
  delete db.sessions[sha(token)];
  save();
}

// New password for an account; every existing session of that account stops working
export async function setPassword(acc: Account, password: string) {
  const salt = randomBytes(16).toString("hex");
  acc.salt = salt;
  acc.hash = (await derive(password, salt)).toString("hex");
  dropSessionsOf(acc.id);
  save();
}

const nameTaken = (u: string) => Object.values(db.accounts).some((a) => a.username === u);

// New GM accounts start as NOT paid and on the Free tier: the superadmin activates them
export async function createGm(username: string, password: string, campaignName: string) {
  const uname = username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(uname)) return { error: "Username: 3-20 letters, numbers or _" };
  if (password.length < 8 || password.length > 100) return { error: "Password must be 8-100 characters" };
  if (nameTaken(uname)) return { error: "Username already taken" };
  const salt = randomBytes(16).toString("hex");
  const hash = (await derive(password, salt)).toString("hex");
  if (nameTaken(uname)) return { error: "Username already taken" };
  const accId = randomUUID();
  const campId = randomUUID();
  const mapId = randomUUID();
  db.accounts[accId] = {
    id: accId, name: uname, role: "gm", campaignId: campId, username: uname, salt, hash,
    paid: false, tier: "free", createdAt: Date.now(),
  };
  const camp = {
    id: campId, name: campaignName.trim().slice(0, 40) || `${uname}'s table`,
    gmId: accId, memberIds: [], messages: [], invites: [], assets: {},
    maps: { [mapId]: { id: mapId, name: "Map 1", w: 2000, h: 2000, tokens: {}, createdAt: Date.now() } },
    activeMapId: mapId, library: [],
  } as unknown as Campaign;
  bindCampaign(camp);
  db.campaigns[campId] = camp;
  save();
  return { account: db.accounts[accId] };
}

export async function checkLogin(username: string, password: string) {
  const acc = Object.values(db.accounts).find((a) => a.username === username.trim().toLowerCase());
  const key = await derive(password, acc?.salt ?? "0".repeat(32)); // same work even if user is unknown
  if (!acc?.hash) return null;
  const expected = Buffer.from(acc.hash, "hex");
  return key.length === expected.length && timingSafeEqual(key, expected) ? acc : null;
}

// The superadmin comes from the environment, never from the sign-up form
export async function ensureAdmin(username: string, password: string): Promise<{ error?: string }> {
  const uname = username.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(uname)) return { error: "SUPERADMIN_USER must be 3-20 letters, numbers or _" };
  if (password.length < 12) return { error: "SUPERADMIN_PASSWORD must be at least 12 characters" };
  if (Object.values(db.accounts).some((a) => a.role !== "admin" && a.username === uname)) {
    return { error: "SUPERADMIN_USER is already used by a GM account. Choose another name." };
  }
  // The environment is the source of truth: remove any other admin account
  for (const a of Object.values(db.accounts)) {
    if (a.role === "admin" && a.username !== uname) {
      delete db.accounts[a.id];
      dropSessionsOf(a.id);
    }
  }
  let admin = Object.values(db.accounts).find((a) => a.role === "admin");
  const salt = admin?.salt ?? randomBytes(16).toString("hex");
  const hash = (await derive(password, salt)).toString("hex");
  if (!admin) {
    const id = randomUUID();
    admin = { id, name: uname, role: "admin", campaignId: "", username: uname, salt, hash, createdAt: Date.now() };
    db.accounts[id] = admin;
  } else if (admin.hash !== hash) {
    admin.hash = hash; // password changed: old sessions stop working
    dropSessionsOf(admin.id);
  }
  save();
  return {};
}

export function createPlayer(camp: Campaign, name: string) {
  const id = randomUUID();
  db.accounts[id] = { id, name, role: "player", campaignId: camp.id };
  camp.memberIds.push(id);
  save();
  return db.accounts[id];
}

// ---------- invites ----------
// Invites that can still be used
export function activeInvites(camp: Campaign) {
  const now = Date.now();
  return camp.invites.filter((i) => i.expiresAt > now && i.uses < i.maxUses);
}

// Invites shown to the GM: usable ones, plus finished ones from the last 30 days (they show who joined)
export function listInvites(camp: Campaign) {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  camp.invites = camp.invites.filter((i) => i.expiresAt > cutoff);
  return camp.invites;
}

export function findInvite(code: unknown) {
  if (typeof code !== "string") return null;
  for (const camp of Object.values(db.campaigns)) {
    const inv = activeInvites(camp).find((i) => i.code === code);
    if (inv) return { camp, inv };
  }
  return null;
}