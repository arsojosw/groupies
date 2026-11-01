export type Role = "gm" | "player";
export type Me = { id: string; name: string; role: Role };
export type Member = { id: string; name: string; role: Role };
export type Token = {
  id: string; x: number; y: number; color: string; label: string;
  size: number; ownerId: string | null; hp?: number; maxHp?: number; image?: string;
  rot?: number; flip?: boolean; hidden?: boolean; z?: number;
};
export type MapInfo = { image?: string; w: number; h: number };
export type Roll = { formula: string; rolls: number[]; sides: number; total: number; keep?: boolean[] };
export type Msg = {
  id: string; ts: number; fromId: string; fromName: string;
  to: string[] | null; kind: "text" | "roll"; text?: string; roll?: Roll;
};
export type Invite = {
  code: string; expiresAt: number; uses: number; maxUses: number;
  usedBy?: { id: string; name: string; ts: number }[];
};
export type Init = {
  me: Me; campaign: { name: string }; map: MapInfo; members: Member[];
  tokens: Record<string, Token>; messages: Msg[]; invites?: Invite[];
};
export type GmRow = {
  id: string; username: string; campaign: string; players: number; online: number;
  paid: boolean; paidUntil: number | null; createdAt: number; lastLoginAt: number; storage: number;
};
export type LogEntry = { id: string; ts: number; actor: string; action: string; target?: string; detail?: string };
export type AdminInit = { me: { id: string; name: string }; gms: GmRow[]; log: LogEntry[] };
export type Locked = { role: Role; campaign: string };