import { promises as fs } from "fs";
import path from "path";
import { randomBytes, createHash, scrypt, timingSafeEqual, randomUUID } from "crypto";

export type Role = "gm" | "player";
export type Account = {
  id: string; name: string; role: Role; campaignId: string;
  username?: string; salt?: string; hash?: string; // only GM accounts have a password
};
export type Token = {
  id: string; x: number; y: number; color: string; label: string;
  size: number; ownerId: string | null; hp: number; maxHp: number; image?: string;
};
export type Roll = { formula: string; rolls: number[]; sides: number; total: number; keep?: boolean[] };
export type Msg = {
  id: string; ts: number; fromId: string; fromName: string;
  to: string[] | null; kind: "text" | "roll"; text?: string; roll?: Roll;
};
export type Invite = { code: string; expiresAt: number; maxUses: number; uses: number };
export type MapInfo = { image?: string; w: number; h: number };
export type Asset = { file: string; size: number };
export type Campaign = {
  id: string; name: string; gmId: string; memberIds: string[];
  tokens: Record<string, Token>; messages: Msg[]; invites: Invite[];
  map: MapInfo; assets: Record<string, Asset>;
};
type DB = {
  accounts: Record<string, Account>;
  sessions: Record<string, { accountId: string; expiresAt: number }>;
  campaigns: Record<string, Campaign>;
};

const FILE = path.join(process.cwd(), "data.json");
export const db: DB = { accounts: {}, sessions: {}, campaigns: {} };

export async function loadDb() {
  try {
    Object.assign(db, JSON.parse(await fs.readFile(FILE, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("Cannot read data.json, fix or remove it:", e);
      process.exit(1);
    }
  }
  const now = Date.now();
  for (const [k, s] of Object.entries(db.sessions)) if (s.expiresAt < now) delete db.sessions[k];
   for (const c of Object.values(db.campaigns)) {
    c.map ??= { w: 2000, h: 2000 };
    c.assets ??= {};
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

const nameTaken = (u: string) => Object.values(db.accounts).some((a) => a.username === u);

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
  db.accounts[accId] = { id: accId, name: uname, role: "gm", campaignId: campId, username: uname, salt, hash };
  db.campaigns[campId] = {
    id: campId, name: campaignName.trim().slice(0, 40) || `${uname}'s table`,
    gmId: accId, memberIds: [], tokens: {}, messages: [], invites: [],
    map: { w: 2000, h: 2000 }, assets: {},
  };
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

export function createPlayer(camp: Campaign, name: string) {
  const id = randomUUID();
  db.accounts[id] = { id, name, role: "player", campaignId: camp.id };
  camp.memberIds.push(id);
  save();
  return db.accounts[id];
}

// ---------- invites ----------
export function activeInvites(camp: Campaign) {
  const now = Date.now();
  camp.invites = camp.invites.filter((i) => i.expiresAt > now && i.uses < i.maxUses);
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