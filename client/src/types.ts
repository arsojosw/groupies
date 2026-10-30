export type Role = "gm" | "player";
export type Me = { id: string; name: string; role: Role };
export type Member = { id: string; name: string; role: Role };
export type Token = {
  id: string; x: number; y: number; color: string; label: string;
  size: number; ownerId: string | null; hp?: number; maxHp?: number;
};
export type Roll = { formula: string; rolls: number[]; sides: number; total: number; keep?: boolean[] };
export type Msg = {
  id: string; ts: number; fromId: string; fromName: string;
  to: string[] | null; kind: "text" | "roll"; text?: string; roll?: Roll;
};
export type Invite = { code: string; expiresAt: number; uses: number; maxUses: number };
export type Init = {
  me: Me; campaign: { name: string }; members: Member[];
  tokens: Record<string, Token>; messages: Msg[]; invites?: Invite[];
};