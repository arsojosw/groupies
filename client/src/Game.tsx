import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import DiceBox from "@3d-dice/dice-box-threejs";
import ChatPanel from "./ChatPanel";
import { signOut, socket } from "./socket";
import { panel, row } from "./styles";
import type { Init, Invite, Member, Msg, Token } from "./types";

type DiceBoxLike = {
  roll: (notation: string) => Promise<unknown>;
  initialize?: () => Promise<unknown>;
  clearDice?: () => void;
};
type TokenPatch = {
  label?: string; color?: string; size?: number; ownerId?: string | null; hp?: number; maxHp?: number;
};

const CELL = 40;
const MAP_W = 600;
const MAP_H = 400;
const DICE_KEY = "vtt:dice3d";
const SIZES = [1, 2, 3, 4, 5];
const D3_SIDES = [4, 6, 8, 10, 12, 20];
const MAX_3D_DICE = 8;

function loadDice3d(): boolean {
  try {
    return localStorage.getItem(DICE_KEY) !== "off";
  } catch {
    return true;
  }
}


export default function Game({ init }: { init: Init }) {
  const { me } = init;
  const isGm = me.role === "gm";
  const [tokens, setTokens] = useState<Record<string, Token>>(init.tokens);
  const [members, setMembers] = useState<Member[]>(init.members);
  const [messages, setMessages] = useState<Msg[]>(init.messages);
  const [invites, setInvites] = useState<Invite[]>(init.invites ?? []);
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState("#8e44ad");
  const [newSize, setNewSize] = useState(1);
  const [newOwner, setNewOwner] = useState("");
  const [newHp, setNewHp] = useState(10);
  const [inviteHours, setInviteHours] = useState(24);
  const [inviteUses, setInviteUses] = useState(6);
  const [inviteError, setInviteError] = useState("");
  const [dice3d, setDice3d] = useState(loadDice3d);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const diceRef = useRef<DiceBoxLike | null>(null);
  const dice3dRef = useRef(dice3d);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const clearTimer = useRef<number | undefined>(undefined);

  const players = members.filter((m) => m.role === "player");
  const ownerName = (id: string | null) => (id === null ? "GM" : members.find((m) => m.id === id)?.name ?? "?");

  useEffect(() => {
    dice3dRef.current = dice3d;
    try {
      localStorage.setItem(DICE_KEY, dice3d ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, [dice3d]);

  // 3D dice layer
  useEffect(() => {
    let cancelled = false;
    const layer = document.getElementById("dice-layer");
    (async () => {
      try {
        const box: DiceBoxLike = new DiceBox("#dice-layer", { sounds: false, theme_colorset: "white" });
        if (typeof box.initialize === "function") await box.initialize();
        if (!cancelled) diceRef.current = box;
      } catch (err) {
        console.warn("3D dice unavailable, using text log only", err);
      }
    })();
    return () => {
      cancelled = true;
      diceRef.current = null;
      layer?.replaceChildren();
    };
  }, []);

  useEffect(() => {
    socket.on("members", setMembers);
    socket.on("invites", setInvites);
    const upsert = (t: Token) => setTokens((all) => ({ ...all, [t.id]: t }));
    socket.on("tokenAdded", upsert);
    socket.on("tokenUpdated", upsert);
    socket.on("tokenRemoved", (id: string) =>
      setTokens((all) => {
        const next = { ...all };
        delete next[id];
        return next;
      })
    );
    socket.on("moved", ({ id, x, y }: { id: string; x: number; y: number }) =>
      setTokens((all) => (all[id] ? { ...all, [id]: { ...all[id], x, y } } : all))
    );
    socket.on("chat", (m: Msg) => {
      // Messages are handled one at a time so dice animations do not overlap
      queue.current = queue.current.then(async () => {
        const box = diceRef.current;
        const r = m.kind === "roll" ? m.roll : undefined;
        if (r && dice3dRef.current && box && D3_SIDES.includes(r.sides) && r.rolls.length <= MAX_3D_DICE) {
          try {
            window.clearTimeout(clearTimer.current);
            box.clearDice?.();
            const notation = `${r.rolls.length}d${r.sides}@${r.rolls.join(",")}`;
            await Promise.race([box.roll(notation), new Promise((res) => setTimeout(res, 6000))]);
            clearTimer.current = window.setTimeout(() => diceRef.current?.clearDice?.(), 3000);
          } catch (err) {
            console.warn("3D roll failed", err);
          }
        }
        setMessages((all) => (all.some((x) => x.id === m.id) ? all : [...all, m].slice(-200)));
      });
    });
    return () => {
      socket.off("members");
      socket.off("invites");
      socket.off("tokenAdded");
      socket.off("tokenUpdated");
      socket.off("tokenRemoved");
      socket.off("moved");
      socket.off("chat");
    };
  }, []);

  const canMove = (t: Token) => isGm || t.ownerId === me.id;

  const mapPos = (e: PointerEvent<HTMLDivElement>) => {
    const r = mapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onDown = (e: PointerEvent<HTMLDivElement>, t: Token) => {
    if (!canMove(t)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = mapPos(e);
    drag.current = { id: t.id, dx: p.x - t.x, dy: p.y - t.y };
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const t = tokens[d.id];
    if (!t) return;
    const p = mapPos(e);
    const x = Math.max(0, Math.min(MAP_W - t.size * CELL, p.x - d.dx));
    const y = Math.max(0, Math.min(MAP_H - t.size * CELL, p.y - d.dy));
    setTokens((all) => ({ ...all, [d.id]: { ...all[d.id], x, y } }));
    socket.emit("move", { id: d.id, x, y });
  };

  const update = (id: string, patch: TokenPatch) => {
    setTokens((all) => ({ ...all, [id]: { ...all[id], ...patch } }));
    socket.emit("updateToken", { id, ...patch });
  };

  const setHp = (id: string, hp: number) => {
    setTokens((all) => ({ ...all, [id]: { ...all[id], hp } }));
    socket.emit("setHp", { id, hp });
  };

  const addToken = () => {
    socket.emit("addToken", {
      label: newLabel, color: newColor, size: newSize, ownerId: newOwner || null, hp: newHp, maxHp: newHp,
    });
    setNewLabel("");
  };

  const createInvite = () =>
    socket.emit("createInvite", { hours: inviteHours, maxUses: inviteUses }, (r: { error?: string }) =>
      setInviteError(r?.error ?? "")
    );

  const hpColor = (t: Token) => {
    const pct = (t.hp ?? 0) / (t.maxHp || 1);
    return pct > 0.5 ? "#2ecc71" : pct > 0.25 ? "#f1c40f" : "#e74c3c";
  };

  const inviteLink = (code: string) => `${window.location.origin}/?join=${code}`;

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 1080, margin: "0 auto" }}>
      <h2 style={{ marginTop: 0 }}>
        {init.campaign.name}{" "}
        <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 10, background: isGm ? "#222" : "#2a7", color: "#fff" }}>
          {isGm ? "GM" : "PLAYER"}
        </span>{" "}
        <span style={{ fontSize: 13, fontWeight: "normal", color: "#555" }}>
          {me.name} <button onClick={signOut}>Sign out</button>
        </span>
      </h2>

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* LEFT: map */}
        <div>
          <div
            ref={mapRef}
            style={{
              position: "relative", width: MAP_W, height: MAP_H, background: "#e8e0cc",
              backgroundImage:
                "linear-gradient(#0001 1px, transparent 1px), linear-gradient(90deg, #0001 1px, transparent 1px)",
              backgroundSize: `${CELL}px ${CELL}px`, border: "2px solid #333", marginBottom: 30,
            }}
          >
            {Object.values(tokens).map((t) => (
            <div
                key={t.id}
                title={`${t.label} (${ownerName(t.ownerId)})`}
                onPointerDown={(e) => onDown(e, t)}
                onPointerMove={onMove}
                onPointerUp={() => (drag.current = null)}
                style={{
                position: "absolute", left: t.x, top: t.y, width: t.size * CELL, height: t.size * CELL,
                cursor: canMove(t) ? "grab" : "default", userSelect: "none", touchAction: "none",
                }}
            >
                <div
                style={{
                    width: "100%", height: "100%", borderRadius: "50%", background: t.color, boxSizing: "border-box",
                    border: `3px solid ${t.ownerId === null ? "#222" : t.ownerId === me.id ? "#f1c40f" : "#fff"}`,
                }}
                />
                <div
                style={{
                    position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)", marginTop: 2,
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
                }}
                >
                <span
                    style={{
                    maxWidth: Math.max(t.size * CELL + 40, 80), overflow: "hidden", textOverflow: "ellipsis",
                    whiteSpace: "nowrap", fontSize: 11, fontWeight: 600, color: "#222",
                    background: "#ffffffcc", borderRadius: 4, padding: "0 4px",
                    }}
                >
                    {t.label}
                </span>
                {t.hp !== undefined && t.maxHp !== undefined && (
                    <div
                    style={{
                        width: Math.max(t.size * CELL, 40), height: 6, background: "#0005",
                        border: "1px solid #0008", borderRadius: 3, boxSizing: "border-box", overflow: "hidden",
                    }}
                    >
                    <div
                        style={{
                        width: `${Math.max(0, Math.min(100, (t.hp / t.maxHp) * 100))}%`,
                        height: "100%", background: hpColor(t),
                        }}
                    />
                    </div>
                )}
                </div>
            </div>
            ))}
            {/* 3D dice are drawn here, above the tokens; clicks pass through */}
            <div id="dice-layer" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 50 }} />
          </div>
          <div style={{ fontSize: 12, color: "#555", marginTop: 6 }}>
            Gold ring = your token. White ring = another player. Dark ring = GM token. You can move only your own token.
          </div>
        </div>

        {/* RIGHT: panels */}
        <div style={{ flex: 1, minWidth: 300 }}>
          {isGm && (
            <div style={panel}>
              <b>Invite players</b>
              <div style={{ ...row, marginTop: 6 }}>
                <select value={inviteHours} onChange={(e) => setInviteHours(Number(e.target.value))}>
                  <option value={1}>Expires in 1 hour</option>
                  <option value={24}>Expires in 24 hours</option>
                  <option value={168}>Expires in 7 days</option>
                </select>
                <label style={{ fontSize: 13 }}>
                  Max uses{" "}
                  <input
                    type="number" min={1} max={20} value={inviteUses} style={{ width: 50 }}
                    onChange={(e) => setInviteUses(Number(e.target.value))}
                  />
                </label>
                <button onClick={createInvite}>Create link</button>
              </div>
              {inviteError && <div style={{ color: "#c0392b", fontSize: 13, marginTop: 4 }}>{inviteError}</div>}
              {invites.filter((i) => i.expiresAt > Date.now()).map((i) => (
                <div key={i.code} style={{ marginTop: 8 }}>
                  <div style={row}>
                    <input readOnly value={inviteLink(i.code)} style={{ flex: 1, minWidth: 120 }} />
                    <button onClick={() => navigator.clipboard.writeText(inviteLink(i.code))}>Copy</button>
                    <button onClick={() => socket.emit("revokeInvite", i.code)}>Revoke</button>
                  </div>
                  <div style={{ fontSize: 11, color: "#777" }}>
                    Used {i.uses}/{i.maxUses}. Expires {new Date(i.expiresAt).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          )}

          <ChatPanel me={me} members={members} messages={messages} dice3d={dice3d} onDice3d={setDice3d} />

          <div style={panel}>
            <b>Tokens</b>
            {Object.values(tokens).length === 0 && <div style={{ color: "#777", marginTop: 6 }}>No tokens yet.</div>}
            {Object.values(tokens).map((t) =>
              isGm ? (
                <div key={t.id} style={{ borderTop: "1px solid #eee", marginTop: 8, paddingTop: 8 }}>
                  <div style={row}>
                    <input type="color" value={t.color} onChange={(e) => update(t.id, { color: e.target.value })} />
                    <input
                      key={t.id + t.label}
                      defaultValue={t.label}
                      maxLength={20}
                      style={{ flex: 1, minWidth: 80 }}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== t.label) update(t.id, { label: v });
                      }}
                    />
                    <button onClick={() => socket.emit("removeToken", t.id)}>Delete</button>
                  </div>
                  <div style={{ ...row, marginTop: 6 }}>
                    <select value={t.size} onChange={(e) => update(t.id, { size: Number(e.target.value) })}>
                      {SIZES.map((s) => (
                        <option key={s} value={s}>{s}x{s}</option>
                      ))}
                    </select>
                    <select value={t.ownerId ?? ""} onChange={(e) => update(t.id, { ownerId: e.target.value || null })}>
                      <option value="">GM (NPC / monster)</option>
                      {players.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <div style={{ ...row, marginTop: 6 }}>
                    HP
                    <input
                      key={`${t.id}hp${t.hp}`} type="number" defaultValue={t.hp} style={{ width: 55 }}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isNaN(v) && v !== t.hp) update(t.id, { hp: v });
                      }}
                    />
                    /
                    <input
                      key={`${t.id}max${t.maxHp}`} type="number" defaultValue={t.maxHp} style={{ width: 55 }}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (!Number.isNaN(v) && v !== t.maxHp) update(t.id, { maxHp: v });
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div key={t.id} style={{ ...row, borderTop: "1px solid #eee", marginTop: 8, paddingTop: 8 }}>
                  <span style={{ width: 14, height: 14, borderRadius: "50%", background: t.color, display: "inline-block" }} />
                  <span style={{ flex: 1 }}>{t.label}</span>
                  <span style={{ fontSize: 12, color: "#555" }}>{ownerName(t.ownerId)}</span>
                  {t.ownerId === me.id && t.hp !== undefined ? (
                    <span style={{ fontSize: 13 }}>
                      HP{" "}
                      <input
                        key={`${t.id}hp${t.hp}`} type="number" defaultValue={t.hp} style={{ width: 55 }}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (!Number.isNaN(v) && v !== t.hp) setHp(t.id, v);
                        }}
                      />{" "}
                      / {t.maxHp}
                    </span>
                  ) : (
                    t.hp !== undefined && <span style={{ fontSize: 12, color: "#555" }}>HP {t.hp}/{t.maxHp}</span>
                  )}
                </div>
              )
            )}
          </div>

          {isGm && (
            <div style={panel}>
              <b>Add token</b>
              <div style={{ ...row, marginTop: 6 }}>
                <input
                  placeholder="Token name"
                  value={newLabel}
                  maxLength={20}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addToken()}
                  style={{ flex: 1, minWidth: 100 }}
                />
                <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
              </div>
              <div style={{ ...row, marginTop: 6 }}>
                <select value={newSize} onChange={(e) => setNewSize(Number(e.target.value))}>
                  {SIZES.map((s) => (
                    <option key={s} value={s}>{s}x{s}</option>
                  ))}
                </select>
                <select value={newOwner} onChange={(e) => setNewOwner(e.target.value)}>
                  <option value="">GM (NPC / monster)</option>
                  {players.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <label>
                  HP{" "}
                  <input
                    type="number" min={1} max={9999} value={newHp} style={{ width: 60 }}
                    onChange={(e) => setNewHp(Number(e.target.value))}
                  />
                </label>
                <button onClick={addToken}>Add</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}