export type Role = "gm" | "player";
export type Tier = "free" | "basic" | "pro" | "master";
export type TierSetting = { maxMaps: number; storageMb: number };
export type Me = { id: string; name: string; role: Role };
export type Member = { id: string; name: string; role: Role };
export type Token = {
  id: string; x: number; y: number; color: string; label: string;
  size: number; ownerId: string | null; hp?: number; maxHp?: number; image?: string;
  rot?: number; flip?: boolean; hidden?: boolean; z?: number;
};
export type MapInfo = { id?: string; name?: string; image?: string; w: number; h: number };
export type MapSummary = { id: string; name: string; w: number; h: number; image?: string; thumb?: string };
export type SavedToken = {
  id: string; label: string; color: string; size: number; maxHp: number;
  image?: string; rot?: number; flip?: boolean; ownerId?: string | null; savedAt: number;
  fromTokenId?: string;
};
export type TierInfo = { tier: Tier; maxMaps: number; mapCount: number; storageMb: number; usedBytes: number };
export type MapsPayload = { activeMapId: string; maps: MapSummary[]; tier: TierInfo };
export type Roll = { formula: string; rolls: number[]; sides: number; total: number; keep?: boolean[] };
export type Msg = {
  id: string; ts: number; fromId: string; fromName: string;
  to: string[] | null; kind: "text" | "roll" | "action"; text?: string; roll?: Roll;
};
export type Invite = {
  code: string; expiresAt: number; uses: number; maxUses: number;
  usedBy?: { id: string; name: string; ts: number }[];
};
export type Init = {
  me: Me; campaign: { name: string }; map: MapInfo; members: Member[];
  tokens: Record<string, Token>; messages: Msg[]; invites?: Invite[];
    initiative: InitiativeState;
  measure: Measure;
  drawings: Drawing[];
  // GM only
  library?: SavedToken[]; maps?: MapSummary[]; activeMapId?: string; tier?: TierInfo;
  
};
export type Drawing = { id: string; points: [number, number][]; stroke: string | null; fill: string | null };
export type GmRow = {
  id: string; username: string; campaign: string; players: number; online: number;
  paid: boolean; paidUntil: number | null; tier: Tier; maps: number;
  createdAt: number; lastLoginAt: number; storage: number;
};
export type LogEntry = { id: string; ts: number; actor: string; action: string; target?: string; detail?: string };
export type AdminInit = {
  me: { id: string; name: string }; gms: GmRow[]; log: LogEntry[];
  settings: { tiers: Record<Tier, TierSetting> };
};
export type Locked = { role: Role; campaign: string };
export type InitEntry = { tokenId: string; value: number | null };
export type InitiativeState = { active: boolean; startedAt: number; die: number; entries: InitEntry[] };
export type Measure = { ftPerSquare: number; melee: number; veryClose: number; close: number; far: number };