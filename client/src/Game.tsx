import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, PointerEvent } from "react";
import DiceBox from "@3d-dice/dice-box-threejs";
import ChatPanel from "./ChatPanel";
import { prepareMap, prepareToken, upload } from "./imageUtils";
import { signOut, socket } from "./socket";
import { row } from "./styles";
import type { Init, Invite, MapInfo, Member, Msg, Token } from "./types";

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
type Dims = { w: number; h: number };
type Tab = "token" | "chat" | "dice" | "tokens" | "map" | "invite";
type Gesture =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: "token"; id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean }
  | { kind: "pinch"; dist: number; z: number; mapX: number; mapY: number }
  | null;

const CELL = 40;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const EDGE = 60; // how far past the map edge you can pan
const TAP_SLOP = 6; // movement (px) under which a press counts as a tap
const DICE_KEY = "vtt:dice3d";
const SNAP_KEY = "vtt:snap";
const GRID_KEY = "vtt:grid";
const HINT_KEY = "vtt:hint";
const SIZES = [1, 2, 3, 4, 5];
const D3_SIDES = [4, 6, 8, 10, 12, 20];
const MAX_3D_DICE = 8;

const floating: CSSProperties = {
  background: "#fff", border: "1px solid #bbb", borderRadius: 10, boxShadow: "0 6px 24px #0005",
};

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v !== "off";
  } catch {
    return fallback;
  }
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const clampZoom = (z: number) => clamp(z, MIN_ZOOM, MAX_ZOOM);

const clampPos = (d: Dims, size: number, x: number, y: number): Pt => ({
  x: clamp(x, 0, d.w - size * CELL),
  y: clamp(y, 0, d.h - size * CELL),
});

const snapPos = (d: Dims, size: number, x: number, y: number): Pt =>
  clampPos(d, size, Math.round(x / CELL) * CELL, Math.round(y / CELL) * CELL);

// Keeps the map from being dragged out of sight; centers it when zoomed far out
function constrain(v: View, w: number, h: number, d: Dims): View {
  const fix = (pos: number, mapSize: number, viewSize: number) => {
    const s = mapSize * v.z;
    if (s <= viewSize) return (viewSize - s) / 2;
    return Math.min(EDGE, Math.max(viewSize - s - EDGE, pos));
  };
  return { x: fix(v.x, d.w, w), y: fix(v.y, d.h, h), z: v.z };
}

// Map size for a number of squares across, keeping the picture's shape
function sizeFor(squares: number, aspect: number): Dims {
  let w = clamp(Math.round(squares) || 50, 10, 100) * CELL;
  let h = Math.round(w * aspect);
  if (h > 4000) {
    h = 4000;
    w = Math.round(h / aspect);
  }
  if (h < 400) {
    h = 400;
    w = Math.round(h / aspect);
  }
  return { w, h };
}

// True on phone-sized screens
function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 700px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

const toastText = (m: Msg) =>
  m.kind === "roll" && m.roll
    ? `${m.fromName} rolled ${m.roll.formula} = ${m.roll.total}`
    : `${m.fromName}${m.to ? " (whisper)" : ""}: ${m.text ?? ""}`;

export default function Game({ init }: { init: Init }) {
  const { me } = init;
  const isGm = me.role === "gm";
  const narrow = useNarrow();

  const [tokens, setTokens] = useState<Record<string, Token>>(init.tokens);
  const [map, setMap] = useState<MapInfo>(init.map);
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
  const [squaresDraft, setSquaresDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [dice3d, setDice3d] = useState(() => loadFlag(DICE_KEY, true));
  const [snap, setSnap] = useState(() => loadFlag(SNAP_KEY, true));
  const [showGrid, setShowGrid] = useState(() => loadFlag(GRID_KEY, true));

  // panel and menu
  const [open, setOpen] = useState(isGm); // GM starts with the panel open, players with it closed
  const [tab, setTab] = useState<Tab>(isGm ? "tokens" : "token");
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState<Msg | null>(null);
  const [hint, setHint] = useState(() => !isGm && loadFlag(HINT_KEY, true));

  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLSpanElement | null>(null);
  const mapFileRef = useRef<HTMLInputElement>(null);
  const tokenFileRef = useRef<HTMLInputElement>(null);
  const tokenUploadId = useRef<string | null>(null);
  const view = useRef<View>({ x: 20, y: 20, z: 1 });
  const dims = useRef<Dims>({ w: init.map.w, h: init.map.h });
  const lastImage = useRef(init.map.image);
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<Gesture>(null);
  const dragPos = useRef<Pt | null>(null);
  const lastEmit = useRef(0);
  const chatVisible = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);

  const diceRef = useRef<DiceBoxLike | null>(null);
  const dice3dRef = useRef(dice3d);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const clearTimer = useRef<number | undefined>(undefined);

  const players = members.filter((m) => m.role === "player");
  const mine = Object.values(tokens).find((t) => t.ownerId === me.id);
  const ownTokens = Object.values(tokens).filter((t) => t.ownerId === me.id);
  const ownerName = (id: string | null) => (id === null ? "GM" : members.find((m) => m.id === id)?.name ?? "?");

  // ---------- panel ----------
  const openTab = (t: Tab) => {
    setTab(t);
    setOpen(true);
    setMenuOpen(false);
    if (t === "chat") {
      setUnread(0);
      setToast(null);
    }
    if (hint) {
      setHint(false);
      try {
        localStorage.setItem(HINT_KEY, "off");
      } catch {
        /* ignore */
      }
    }
  };

  const tabs: { id: Tab; label: string }[] = isGm
    ? [
        { id: "chat", label: "Chat" },
        { id: "dice", label: "Dice" },
        { id: "tokens", label: "Tokens" },
        { id: "map", label: "Map" },
        { id: "invite", label: "Invite" },
      ]
    : [
        { id: "token", label: "Token" },
        { id: "chat", label: "Chat" },
        { id: "dice", label: "Dice" },
      ];

  useEffect(() => {
    chatVisible.current = open && tab === "chat";
  }, [open, tab]);

  // The map is full screen, so the page itself must not scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Bring the selected token's card into view
  useEffect(() => {
    if (!open || !selectedId) return;
    document.getElementById(`tok-${selectedId}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, open, tab]);

  // ---------- view (pan and zoom) ----------
  // The transform is written straight to the DOM so panning stays smooth
  const applyView = useCallback((next: View) => {
    const vp = viewportRef.current;
    const v = vp ? constrain(next, vp.clientWidth, vp.clientHeight, dims.current) : next;
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

  const fitMap = useCallback(() => {
    const vp = viewportRef.current;
    const w = vp?.clientWidth ?? 600;
    const h = vp?.clientHeight ?? 400;
    const d = dims.current;
    const z = clampZoom(Math.min(w / d.w, h / d.h));
    applyView({ x: (w - d.w * z) / 2, y: (h - d.h * z) / 2, z });
  }, [applyView]);

  const zoomBy = (f: number) => {
    const { w, h } = vpSize();
    zoomAt(w / 2, h / 2, view.current.z * f);
  };
  const resetZoom = () => {
    const { w, h } = vpSize();
    zoomAt(w / 2, h / 2, 1);
  };
  const centerOn = (t: Token) => {
    const { w, h } = vpSize();
    const z = Math.max(view.current.z, 0.6);
    const cx = t.x + (t.size * CELL) / 2;
    const cy = t.y + (t.size * CELL) / 2;
    applyView({ x: w / 2 - cx * z, y: h / 2 - cy * z, z });
  };

  // Starting view: your own token, else the whole map if it has a picture, else the top-left
  useEffect(() => {
    const vp = viewportRef.current;
    const own = Object.values(init.tokens).find((t) => t.ownerId === init.me.id);
    if (vp && own) {
      const cx = own.x + (own.size * CELL) / 2;
      const cy = own.y + (own.size * CELL) / 2;
      applyView({ x: vp.clientWidth / 2 - cx, y: vp.clientHeight / 2 - cy, z: 1 });
    } else if (init.map.image) {
      fitMap();
    } else {
      applyView({ x: 20, y: 20, z: 1 });
    }
  }, [applyView, fitMap, init]);

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
      localStorage.setItem(GRID_KEY, showGrid ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, [snap, showGrid]);

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
    socket.on("map", (m: MapInfo) => {
      dims.current = { w: m.w, h: m.h };
      setMap(m);
      if (m.image !== lastImage.current) {
        lastImage.current = m.image;
        fitMap(); // a new picture: show the whole map
      } else {
        applyView(view.current); // just resized: keep the current zoom
      }
    });
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
        // Someone else's message while the chat is not on screen: unread count and a short pop-up
        if (m.fromId !== me.id && !chatVisible.current) {
          setUnread((u) => u + 1);
          setToast(m);
          window.clearTimeout(toastTimer.current);
          toastTimer.current = window.setTimeout(() => setToast(null), 6000);
        }
      });
    });
    return () => {
      socket.off("members");
      socket.off("invites");
      socket.off("map");
      socket.off("tokenAdded");
      socket.off("tokenUpdated");
      socket.off("tokenRemoved");
      socket.off("moved");
      socket.off("chat");
    };
  }, [applyView, fitMap, me.id]);

  // ---------- pointer handling: tap, drag token, pan, pinch ----------
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

  // A tap on a token you control opens its panel
  const onTokenTap = (id: string) => {
    setSelectedId(id);
    openTab(isGm ? "tokens" : "token");
  };

  // Drop the token: snap it to the grid (if on) and tell everyone the final spot
  const finishToken = () => {
    const g = gesture.current;
    if (!g || g.kind !== "token") return;
    gesture.current = null;
    if (!g.moved) {
      onTokenTap(g.id);
      return;
    }
    const t = tokens[g.id];
    const last = dragPos.current;
    if (!t || !last) return;
    const end = snap ? snapPos(dims.current, t.size, last.x, last.y) : last;
    setTokens((all) => (all[g.id] ? { ...all, [g.id]: { ...all[g.id], x: end.x, y: end.y } } : all));
    socket.emit("move", { id: g.id, x: end.x, y: end.y });
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (pointers.current.size >= 2) return;
    setMenuOpen(false);
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
      gesture.current = { kind: "token", id: t.id, dx: m.x - t.x, dy: m.y - t.y, sx: p.x, sy: p.y, moved: false };
    } else {
      gesture.current = { kind: "pan", sx: p.x, sy: p.y, vx: view.current.x, vy: view.current.y, moved: false };
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
      return;
    }

    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) > TAP_SLOP) g.moved = true;
    if (!g.moved) return;

    if (g.kind === "pan") {
      applyView({ ...view.current, x: g.vx + (p.x - g.sx), y: g.vy + (p.y - g.sy) });
    } else {
      const t = tokens[g.id];
      if (!t) return;
      const m = toMap(p);
      const pos = clampPos(dims.current, t.size, m.x - g.dx, m.y - g.dy);
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
      gesture.current = { kind: "pan", sx: p.x, sy: p.y, vx: view.current.x, vy: view.current.y, moved: true };
    } else if (g?.kind === "pan" && !g.moved && !isGm) {
      setOpen(false); // players: tap on empty map closes the panel
    }
    if (pointers.current.size === 0) gesture.current = null;
  };

  // ---------- token, map and invite actions ----------
  const update = (id: string, patch: TokenPatch) => {
    setTokens((all) => ({ ...all, [id]: { ...all[id], ...patch } }));
    socket.emit("updateToken", { id, ...patch });
  };

  const setHp = (id: string, hp: number) => {
    setTokens((all) => ({ ...all, [id]: { ...all[id], hp } }));
    socket.emit("setHp", { id, hp });
  };

  // New tokens appear in the middle of the part of the map the GM can see
  const addToken = () => {
    const { w, h } = vpSize();
    let sx = w / 2;
    let sy = h / 2;
    if (open) {
      if (narrow) sy = (h * 0.42) / 2;
      else sx = Math.max(100, (w - 392) / 2);
    }
    const v = view.current;
    const cx = (sx - v.x) / v.z;
    const cy = (sy - v.y) / v.z;
    const s = snapPos(dims.current, newSize, cx - (newSize * CELL) / 2, cy - (newSize * CELL) / 2);
    socket.emit("addToken", {
      label: newLabel, color: newColor, size: newSize, ownerId: newOwner || null,
      hp: newHp, maxHp: newHp, x: s.x, y: s.y,
    });
    setNewLabel("");
  };

  const applySquares = () => {
    const n = Number(squaresDraft ?? Math.round(map.w / CELL));
    socket.emit("setMap", sizeFor(n, map.h / map.w));
    setSquaresDraft(null);
  };

  const onMapFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy("Uploading map...");
    setUploadError("");
    try {
      const p = await prepareMap(file);
      // Guess the grid: most battle maps use about 70 px per square
      const size = sizeFor(Math.round(p.width / 70), p.height / p.width);
      const err = await upload("map", p.blob, size);
      if (err) setUploadError(err);
      else setSquaresDraft(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    }
    setBusy("");
  };

  const onTokenFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const id = tokenUploadId.current;
    if (!file || !id) return;
    setBusy("Uploading token image...");
    setUploadError("");
    try {
      const blob = await prepareToken(file);
      const err = await upload("token", blob, { tokenId: id });
      if (err) setUploadError(err);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    }
    setBusy("");
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

  // Grid lines: a dark and a light line together so they show on any picture
  const gridImage = map.image
    ? "linear-gradient(rgba(0,0,0,.35) 1px, rgba(255,255,255,.3) 1px 2px, transparent 2px), linear-gradient(90deg, rgba(0,0,0,.35) 1px, rgba(255,255,255,.3) 1px 2px, transparent 2px)"
    : "linear-gradient(#0002 1px, transparent 1px), linear-gradient(90deg, #0002 1px, transparent 1px)";

  const status = busy ? (
    <div style={{ fontSize: 13, color: "#555", marginTop: 6 }}>{busy}</div>
  ) : uploadError ? (
    <div style={{ fontSize: 13, color: "#c0392b", marginTop: 6 }}>{uploadError}</div>
  ) : null;

  const hpBar = (t: Token) =>
    t.hp !== undefined && t.maxHp !== undefined ? (
      <div style={{ height: 8, background: "#0002", borderRadius: 4, overflow: "hidden", marginTop: 6 }}>
        <div style={{ width: `${clamp((t.hp / t.maxHp) * 100, 0, 100)}%`, height: "100%", background: hpColor(t) }} />
      </div>
    ) : null;

  const show = (t: Tab): CSSProperties => ({ display: tab === t ? "block" : "none" });
  const cardStyle = (id: string): CSSProperties => ({
    border: id === selectedId ? "2px solid #f1c40f" : "1px solid #ddd",
    borderRadius: 8, padding: 10, marginBottom: 8,
  });

  const panelPos: CSSProperties = narrow
    ? { left: 0, right: 0, bottom: 0, height: "58%", borderRadius: "12px 12px 0 0" }
    : { top: 12, right: 12, width: 380, height: "min(620px, calc(100% - 24px))" };

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", fontFamily: "sans-serif", background: "#222" }}>
      {/* ---------- full screen map ---------- */}
      <div
        ref={viewportRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          position: "absolute", inset: 0, overflow: "hidden", background: "#3a3a3a",
          touchAction: "none", userSelect: "none", cursor: "grab",
        }}
      >
        <div
          ref={layerRef}
          style={{
            position: "absolute", left: 0, top: 0, width: map.w, height: map.h,
            transformOrigin: "0 0", boxShadow: "0 0 0 2px #222",
            background: map.image ? `#bbb url(${map.image}) 0 0 / 100% 100% no-repeat` : "#e8e0cc",
          }}
        >
          {showGrid && (
            <div
              style={{
                position: "absolute", inset: 0, pointerEvents: "none",
                backgroundImage: gridImage, backgroundSize: `${CELL}px ${CELL}px`,
              }}
            />
          )}
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
                  width: "100%", height: "100%", borderRadius: "50%", boxSizing: "border-box",
                  background: t.image ? `url(${t.image}) center / cover no-repeat` : t.color,
                  border: t.image
                    ? "none"
                    : `3px solid ${t.ownerId === null ? "#222" : t.ownerId === me.id ? "#f1c40f" : "#fff"}`,
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
                        width: `${clamp((t.hp / t.maxHp) * 100, 0, 100)}%`,
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

      {/* ---------- menu button and menu ---------- */}
      <button
        onClick={() => setMenuOpen((v) => !v)}
        title="Menu"
        style={{
          position: "absolute", top: 12, left: 12, zIndex: 100, width: 40, height: 40, borderRadius: 20,
          border: "1px solid #888", background: "#fffe", fontSize: 18, cursor: "pointer",
        }}
      >
        ☰
        {unread > 0 && (
          <span
            style={{
              position: "absolute", top: -4, right: -4, background: "#e74c3c", color: "#fff", borderRadius: 10,
              fontSize: 11, minWidth: 18, height: 18, lineHeight: "18px", textAlign: "center",
            }}
          >
            {unread}
          </span>
        )}
      </button>

      {menuOpen && (
        <div style={{ ...floating, position: "absolute", top: 60, left: 12, zIndex: 100, width: 270, padding: 12 }}>
          <div>
            <b>{init.campaign.name}</b>
          </div>
          <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>
            {me.name} ({isGm ? "GM" : "player"}){" "}
            <button onClick={signOut}>Sign out</button>
          </div>
          <div style={{ ...row, marginTop: 10 }}>
            <button onClick={() => zoomBy(1 / 1.25)} title="Zoom out">−</button>
            <span
              ref={(el) => {
                zoomRef.current = el;
                if (el) el.textContent = `${Math.round(view.current.z * 100)}%`;
              }}
              style={{ minWidth: 44, textAlign: "center", fontSize: 13 }}
            />
            <button onClick={() => zoomBy(1.25)} title="Zoom in">+</button>
            <button onClick={resetZoom}>100%</button>
          </div>
          <div style={{ ...row, marginTop: 6 }}>
            <button onClick={fitMap}>Fit map</button>
            {mine && <button onClick={() => centerOn(mine)}>My token</button>}
          </div>
          <label style={{ display: "block", fontSize: 13, marginTop: 8 }}>
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap to grid
          </label>
          <label style={{ display: "block", fontSize: 13 }}>
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Show grid
          </label>
          {!isGm && (
            <div style={{ ...row, marginTop: 10 }}>
              <button onClick={() => openTab("chat")}>Chat{unread > 0 ? ` (${unread})` : ""}</button>
              <button onClick={() => openTab("dice")}>Dice</button>
              {mine && <button onClick={() => { setSelectedId(mine.id); openTab("token"); }}>My token</button>}
            </div>
          )}
        </div>
      )}

      {/* ---------- GM dock (panel minimized) ---------- */}
      {!open && isGm && (
        <div
          style={{
            position: "absolute", right: 12, bottom: 12, zIndex: 90, display: "flex", gap: 6,
            flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "calc(100% - 24px)",
          }}
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => openTab(t.id)}
              style={{
                ...floating, borderRadius: 16, padding: "6px 12px", cursor: "pointer", fontSize: 13,
              }}
            >
              {t.label}
              {t.id === "chat" && unread > 0 ? ` (${unread})` : ""}
            </button>
          ))}
        </div>
      )}

      {/* ---------- first-time hint for players ---------- */}
      {hint && !open && (
        <div
          style={{
            position: "absolute", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 90,
            background: "#222d", color: "#fff", borderRadius: 16, padding: "8px 14px", fontSize: 13,
            maxWidth: "calc(100% - 32px)", textAlign: "center", pointerEvents: "none",
          }}
        >
          Tap your token to open chat, dice and your stats
        </div>
      )}

      {/* ---------- new message pop-up ---------- */}
      {toast && !(open && tab === "chat") && (
        <div
          onClick={() => openTab("chat")}
          style={{
            ...floating, position: "absolute", left: 12, zIndex: 110, maxWidth: "min(360px, calc(100% - 24px))",
            bottom: narrow && open ? "calc(58% + 12px)" : 12, padding: "8px 12px", fontSize: 13, cursor: "pointer",
            background: "#f3ecff",
          }}
        >
          {toastText(toast)}
        </div>
      )}

      {/* ---------- tabbed panel ---------- */}
      {open && (
        <div
          style={{
            position: "absolute", zIndex: 90, display: "flex", flexDirection: "column",
            background: "#fff", border: "1px solid #bbb", boxShadow: "0 6px 24px #0005",
            borderRadius: 10, ...panelPos,
          }}
        >
          <div
            style={{
              display: "flex", alignItems: "center", gap: 4, padding: "8px 8px 0",
              borderBottom: "1px solid #ddd", flexWrap: "wrap",
            }}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => openTab(t.id)}
                style={{
                  border: "none", cursor: "pointer", fontSize: 13, padding: "6px 10px",
                  borderRadius: "6px 6px 0 0",
                  background: tab === t.id ? "#222" : "transparent",
                  color: tab === t.id ? "#fff" : "#222",
                }}
              >
                {t.label}
                {t.id === "chat" && unread > 0 ? ` (${unread})` : ""}
              </button>
            ))}
            <span style={{ flex: 1 }} />
            <button
              onClick={() => setOpen(false)}
              title={isGm ? "Minimize" : "Close"}
              style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16 }}
            >
              {isGm ? "–" : "✕"}
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
            <div style={show("chat")}>
              <ChatPanel mode="chat" me={me} members={members} messages={messages} dice3d={dice3d} onDice3d={setDice3d} />
            </div>
            <div style={show("dice")}>
              <ChatPanel mode="dice" me={me} members={members} messages={messages} dice3d={dice3d} onDice3d={setDice3d} />
            </div>

            {/* Player: own token(s) */}
            {!isGm && (
              <div style={show("token")}>
                {ownTokens.length === 0 && <div style={{ color: "#777" }}>You do not have a token yet.</div>}
                {ownTokens.map((t) => (
                  <div key={t.id} id={`tok-${t.id}`} style={cardStyle(t.id)}>
                    <div style={row}>
                      <span
                        style={{
                          width: 44, height: 44, borderRadius: "50%", flex: "none", border: "2px solid #ddd",
                          background: t.image ? `url(${t.image}) center / cover no-repeat` : t.color,
                        }}
                      />
                      <div style={{ flex: 1 }}>
                        <b>{t.label}</b>
                        <div style={{ fontSize: 12, color: "#777" }}>Size {t.size}x{t.size}</div>
                      </div>
                      <button onClick={() => centerOn(t)}>Find</button>
                    </div>
                    <div style={{ ...row, marginTop: 8 }}>
                      HP
                      <input
                        key={`${t.id}hp${t.hp}`} type="number" defaultValue={t.hp} style={{ width: 60 }}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (!Number.isNaN(v) && v !== t.hp) setHp(t.id, v);
                        }}
                      />
                      / {t.maxHp}
                    </div>
                    {hpBar(t)}
                  </div>
                ))}
              </div>
            )}

            {/* GM: all tokens and the add form */}
            {isGm && (
              <div style={show("tokens")}>
                <details style={{ marginBottom: 10 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 600 }}>Add token</summary>
                  <div style={{ ...row, marginTop: 8 }}>
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
                  <div style={{ fontSize: 12, color: "#777", marginTop: 6 }}>
                    The token appears in the middle of what you see. Then use "Add image" on its card.
                  </div>
                </details>

                {status}
                {Object.values(tokens).length === 0 && <div style={{ color: "#777" }}>No tokens yet.</div>}
                {Object.values(tokens).map((t) => (
                  <div key={t.id} id={`tok-${t.id}`} style={cardStyle(t.id)}>
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
                    <div style={{ ...row, marginTop: 6 }}>
                      <button
                        disabled={!!busy}
                        onClick={() => {
                          tokenUploadId.current = t.id;
                          tokenFileRef.current?.click();
                        }}
                      >
                        {t.image ? "Change image" : "Add image"}
                      </button>
                      {t.image && <button onClick={() => socket.emit("clearTokenImage", t.id)}>Remove image</button>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* GM: map settings */}
            {isGm && (
              <div style={show("map")}>
                <div style={row}>
                  <button disabled={!!busy} onClick={() => mapFileRef.current?.click()}>
                    {map.image ? "Replace map image" : "Upload map image"}
                  </button>
                  {map.image && <button onClick={() => socket.emit("clearMap")}>Remove image</button>}
                </div>
                <div style={{ ...row, marginTop: 8 }}>
                  <label style={{ fontSize: 13 }}>
                    Squares across{" "}
                    <input
                      type="number" min={10} max={100} style={{ width: 60 }}
                      value={squaresDraft ?? String(Math.round(map.w / CELL))}
                      onChange={(e) => setSquaresDraft(e.target.value)}
                    />
                  </label>
                  <button onClick={applySquares}>Apply</button>
                  <span style={{ fontSize: 12, color: "#777" }}>{map.w} × {map.h} px</span>
                </div>
                <div style={{ fontSize: 12, color: "#777", marginTop: 8 }}>
                  If the picture's own grid does not line up with the game grid, change "Squares across" and press
                  Apply. PNG, JPG or WebP. Large images are resized for you.
                </div>
                {status}
              </div>
            )}

            {/* GM: invite links */}
            {isGm && (
              <div style={show("invite")}>
                <div style={row}>
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
                  <div key={i.code} style={{ marginTop: 10 }}>
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
          </div>
        </div>
      )}

      {/* hidden file pickers (GM) */}
      {isGm && (
        <>
          <input
            ref={mapFileRef} type="file" accept="image/png,image/jpeg,image/webp"
            style={{ display: "none" }} onChange={onMapFile}
          />
          <input
            ref={tokenFileRef} type="file" accept="image/png,image/jpeg,image/webp"
            style={{ display: "none" }} onChange={onTokenFile}
          />
        </>
      )}
    </div>
  );
}