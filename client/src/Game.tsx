import { useCallback, useEffect, useRef, useState } from "react";
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
type View = { x: number; y: number; z: number }; // pan in screen px, zoom factor
type Pt = { x: number; y: number };
type Gesture =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "token"; id: string; dx: number; dy: number }
  | { kind: "pinch"; dist: number; z: number; mapX: number; mapY: number }
  | null;

const CELL = 40;
const MAP_W = 2000; // keep in sync with the server
const MAP_H = 2000;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const EDGE = 60; // how far past the map edge you can pan
const DICE_KEY = "vtt:dice3d";
const SNAP_KEY = "vtt:snap";
const SIZES = [1, 2, 3, 4, 5];
const D3_SIDES = [4, 6, 8, 10, 12, 20];
const MAX_3D_DICE = 8;

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v !== "off";
  } catch {
    return fallback;
  }
}

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

const clampPos = (size: number, x: number, y: number): Pt => ({
  x: Math.max(0, Math.min(MAP_W - size * CELL, x)),
  y: Math.max(0, Math.min(MAP_H - size * CELL, y)),
});

const snapPos = (size: number, x: number, y: number): Pt =>
  clampPos(size, Math.round(x / CELL) * CELL, Math.round(y / CELL) * CELL);

// Keeps the map from being dragged out of sight; centers it when zoomed far out
function constrain(v: View, w: number, h: number): View {
  const fix = (pos: number, mapSize: number, viewSize: number) => {
    const s = mapSize * v.z;
    if (s <= viewSize) return (viewSize - s) / 2;
    return Math.min(EDGE, Math.max(viewSize - s - EDGE, pos));
  };
  return { x: fix(v.x, MAP_W, w), y: fix(v.y, MAP_H, h), z: v.z };
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
  const [dice3d, setDice3d] = useState(() => loadFlag(DICE_KEY, true));
  const [snap, setSnap] = useState(() => loadFlag(SNAP_KEY, true));

  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLSpanElement>(null);
  const view = useRef<View>({ x: 20, y: 20, z: 1 });
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<Gesture>(null);
  const dragPos = useRef<Pt | null>(null);
  const lastEmit = useRef(0);

  const diceRef = useRef<DiceBoxLike | null>(null);
  const dice3dRef = useRef(dice3d);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const clearTimer = useRef<number | undefined>(undefined);

  const players = members.filter((m) => m.role === "player");
  const mine = Object.values(tokens).find((t) => t.ownerId === me.id);
  const ownerName = (id: string | null) => (id === null ? "GM" : members.find((m) => m.id === id)?.name ?? "?");

  // ---------- view (pan and zoom) ----------
  // The transform is written straight to the DOM so panning stays smooth
  const applyView = useCallback((next: View) => {
    const vp = viewportRef.current;
    const v = vp ? constrain(next, vp.clientWidth, vp.clientHeight) : next;
    view.current = v;
    if (layerRef.current) layerRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
    if (zoomRef.current) zoomRef.current.textContent = `${Math.round(v.z * 100)}%`;
  }, []);

  // Zoom while keeping the screen point (cx, cy) fixed
  const zoomAt = useCallback(
    (cx: number, cy: number, nextZ: number) => {
      const v = view.current;
      const z = clampZoom(nextZ);
      const mx = (cx - v.x) / v.z;
      const my = (cy - v.y) / v.z;
      applyView({ x: cx - mx * z, y: cy - my * z, z });
    },
    [applyView]
  );

  const vpSize = () => {
    const vp = viewportRef.current;
    return { w: vp?.clientWidth ?? 600, h: vp?.clientHeight ?? 400 };
  };
  const zoomBy = (f: number) => {
    const { w, h } = vpSize();
    zoomAt(w / 2, h / 2, view.current.z * f);
  };
  const resetZoom = () => {
    const { w, h } = vpSize();
    zoomAt(w / 2, h / 2, 1);
  };
  const fitMap = () => {
    const { w, h } = vpSize();
    const z = clampZoom(Math.min(w / MAP_W, h / MAP_H));
    applyView({ x: (w - MAP_W * z) / 2, y: (h - MAP_H * z) / 2, z });
  };
  const centerOn = (t: Token) => {
    const { w, h } = vpSize();
    const z = Math.max(view.current.z, 0.6);
    const cx = t.x + (t.size * CELL) / 2;
    const cy = t.y + (t.size * CELL) / 2;
    applyView({ x: w / 2 - cx * z, y: h / 2 - cy * z, z });
  };

  // Starting view: centered on your own token, otherwise the top-left of the map
  useEffect(() => {
    const vp = viewportRef.current;
    const own = Object.values(init.tokens).find((t) => t.ownerId === init.me.id);
    if (vp && own) {
      const cx = own.x + (own.size * CELL) / 2;
      const cy = own.y + (own.size * CELL) / 2;
      applyView({ x: vp.clientWidth / 2 - cx, y: vp.clientHeight / 2 - cy, z: 1 });
    } else {
      applyView({ x: 20, y: 20, z: 1 });
    }
  }, [applyView, init]);

  // Mouse wheel / trackpad pinch zoom (needs a non-passive listener to stop page scrolling)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX - r.left - el.clientLeft, e.clientY - r.top - el.clientTop, view.current.z * Math.exp(-dy * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ---------- settings saved per browser ----------
  useEffect(() => {
    dice3dRef.current = dice3d;
    try {
      localStorage.setItem(DICE_KEY, dice3d ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, [dice3d]);

  useEffect(() => {
    try {
      localStorage.setItem(SNAP_KEY, snap ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, [snap]);

  // ---------- 3D dice layer ----------
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

  // ---------- live events ----------
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

  // ---------- pointer handling: drag token, pan, pinch ----------
  const canMove = (t: Token) => isGm || t.ownerId === me.id;

  // Pointer position relative to the viewport
  const local = (e: PointerEvent<HTMLDivElement>): Pt => {
    const vp = viewportRef.current!;
    const r = vp.getBoundingClientRect();
    return { x: e.clientX - r.left - vp.clientLeft, y: e.clientY - r.top - vp.clientTop };
  };
  const toMap = (p: Pt): Pt => ({
    x: (p.x - view.current.x) / view.current.z,
    y: (p.y - view.current.y) / view.current.z,
  });

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    const v = view.current;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    gesture.current = {
      kind: "pinch",
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      z: v.z,
      mapX: (mid.x - v.x) / v.z,
      mapY: (mid.y - v.y) / v.z,
    };
  };

  // Drop the token: snap it to the grid (if on) and tell everyone the final spot
  const finishToken = () => {
    const g = gesture.current;
    if (!g || g.kind !== "token") return;
    gesture.current = null;
    const t = tokens[g.id];
    const last = dragPos.current;
    if (!t || !last) return;
    const end = snap ? snapPos(t.size, last.x, last.y) : last;
    setTokens((all) => (all[g.id] ? { ...all, [g.id]: { ...all[g.id], x: end.x, y: end.y } } : all));
    socket.emit("move", { id: g.id, x: end.x, y: end.y });
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (pointers.current.size >= 2) return;
    viewportRef.current!.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.current.set(e.pointerId, p);

    if (pointers.current.size === 2) {
      finishToken();
      startPinch();
      return;
    }

    const el = (e.target as HTMLElement).closest("[data-token-id]") as HTMLElement | null;
    const t = el ? tokens[el.dataset.tokenId ?? ""] : undefined;
    if (t && canMove(t)) {
      const m = toMap(p);
      dragPos.current = null;
      gesture.current = { kind: "token", id: t.id, dx: m.x - t.x, dy: m.y - t.y };
    } else {
      gesture.current = { kind: "pan", sx: p.x, sy: p.y, vx: view.current.x, vy: view.current.y };
    }
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;

    if (g.kind === "pinch") {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = clampZoom((g.z * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / g.dist);
      applyView({ x: mid.x - g.mapX * z, y: mid.y - g.mapY * z, z });
    } else if (g.kind === "pan") {
      applyView({ ...view.current, x: g.vx + (p.x - g.sx), y: g.vy + (p.y - g.sy) });
    } else {
      const t = tokens[g.id];
      if (!t) return;
      const m = toMap(p);
      const pos = clampPos(t.size, m.x - g.dx, m.y - g.dy);
      dragPos.current = pos;
      setTokens((all) => (all[g.id] ? { ...all, [g.id]: { ...all[g.id], x: pos.x, y: pos.y } } : all));
      const now = Date.now();
      if (now - lastEmit.current > 40) {
        lastEmit.current = now;
        socket.emit("move", { id: g.id, x: pos.x, y: pos.y });
      }
    }
  };

  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === "token") {
      finishToken();
    } else if (g?.kind === "pinch" && pointers.current.size === 1) {
      // One finger left after a pinch: carry on as a pan without jumping
      const [p] = [...pointers.current.values()];
      gesture.current = { kind: "pan", sx: p.x, sy: p.y, vx: view.current.x, vy: view.current.y };
    }
    if (pointers.current.size === 0) gesture.current = null;
  };

  // ---------- token and invite actions ----------
  const update = (id: string, patch: TokenPatch) => {
    setTokens((all) => ({ ...all, [id]: { ...all[id], ...patch } }));
    socket.emit("updateToken", { id, ...patch });
  };

  const setHp = (id: string, hp: number) => {
    setTokens((all) => ({ ...all, [id]: { ...all[id], hp } }));
    socket.emit("setHp", { id, hp });
  };

  // New tokens appear in the middle of what the GM is looking at
  const addToken = () => {
    const { w, h } = vpSize();
    const v = view.current;
    const cx = (w / 2 - v.x) / v.z;
    const cy = (h / 2 - v.y) / v.z;
    const s = snapPos(newSize, cx - (newSize * CELL) / 2, cy - (newSize * CELL) / 2);
    socket.emit("addToken", {
      label: newLabel, color: newColor, size: newSize, ownerId: newOwner || null,
      hp: newHp, maxHp: newHp, x: s.x, y: s.y,
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
    <div style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 1280, margin: "0 auto" }}>
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
        <div style={{ flex: "1 1 560px", minWidth: 0 }}>
          <div style={{ ...row, marginBottom: 6 }}>
            <button onClick={() => zoomBy(1 / 1.25)} title="Zoom out">−</button>
            <span ref={zoomRef} style={{ minWidth: 44, textAlign: "center", fontSize: 13 }}>100%</span>
            <button onClick={() => zoomBy(1.25)} title="Zoom in">+</button>
            <button onClick={resetZoom}>100%</button>
            <button onClick={fitMap}>Fit map</button>
            {mine && <button onClick={() => centerOn(mine)}>My token</button>}
            <label style={{ fontSize: 13, marginLeft: 8 }}>
              <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap to grid
            </label>
          </div>

          <div
            ref={viewportRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onContextMenu={(e) => e.preventDefault()}
            style={{
              position: "relative", width: "100%", height: "min(70vh, 640px)", overflow: "hidden",
              background: "#3a3a3a", border: "2px solid #333", boxSizing: "border-box",
              touchAction: "none", userSelect: "none", cursor: "grab",
            }}
          >
            <div
              ref={layerRef}
              style={{
                position: "absolute", left: 0, top: 0, width: MAP_W, height: MAP_H,
                transformOrigin: "0 0", willChange: "transform", background: "#e8e0cc",
                backgroundImage:
                  "linear-gradient(#0002 1px, transparent 1px), linear-gradient(90deg, #0002 1px, transparent 1px)",
                backgroundSize: `${CELL}px ${CELL}px`, boxShadow: "0 0 0 2px #222",
              }}
            >
              {Object.values(tokens).map((t) => (
                <div
                  key={t.id}
                  data-token-id={t.id}
                  title={`${t.label} (${ownerName(t.ownerId)})`}
                  style={{
                    position: "absolute", left: t.x, top: t.y, width: t.size * CELL, height: t.size * CELL,
                    cursor: canMove(t) ? "pointer" : "default",
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
            </div>
            {/* 3D dice are drawn over the visible area, not the whole map; clicks pass through */}
            <div id="dice-layer" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 50 }} />
          </div>
          <div style={{ fontSize: 12, color: "#555", marginTop: 6 }}>
            Scroll or pinch to zoom, drag the background to pan, drag your own token to move it.
            Gold ring = your token, white = another player, dark = GM token.
          </div>
        </div>

        {/* RIGHT: panels */}
        <div style={{ flex: "0 1 400px", minWidth: 300 }}>
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
                    <button onClick={() => centerOn(t)}>Find</button>
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