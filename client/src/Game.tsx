import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, PointerEvent } from "react";
import DiceBox from "@3d-dice/dice-box-threejs";
import ChatPanel from "./ChatPanel";
import ChangePassword from "./ChangePassword";
import { prepareMap, prepareThumb, prepareToken, upload } from "./imageUtils";
import { signOut, socket } from "./socket";
import { row } from "./styles";
import type {
  Init, InitiativeState, Invite, MapInfo, MapSummary, MapsPayload, Measure, Member, Msg, Roll, SavedToken,
  Tier, TierInfo, Token,
} from "./types";


type DiceBoxLike = {
  roll: (notation: string) => Promise<unknown>;
  initialize?: () => Promise<unknown>;
  clearDice?: () => void;
};
type TokenPatch = {
  label?: string; color?: string; size?: number; ownerId?: string | null;
  hp?: number; maxHp?: number; hidden?: boolean;
};
type View = { x: number; y: number; z: number }; // pan in screen px, zoom factor
type Pt = { x: number; y: number };
type Dims = { w: number; h: number };
type Tab = "token" | "chat" | "initiative" | "tokens" | "library" | "invite" | "settings";
type Tool = "none" | "line" | "circle" | "range";
// A measurement on the map, in map pixels. A range ruler is centered on a token (it follows it) or on a point.
type Ruler = { kind: "line" | "circle" | "range"; ax: number; ay: number; bx: number; by: number; tokenId?: string };
type Gesture =
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number; moved: boolean; tap?: string }
  | { kind: "token"; id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean }
  | { kind: "pinch"; dist: number; z: number; mapX: number; mapY: number }
  | { kind: "measure"; tool: "line" | "circle" }
  | null;

const CELL = 40;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const EDGE = 60; // how far past the map edge you can pan
const TAP_SLOP = 6; // movement (px) under which a press counts as a tap
const ROTATE_STEP = 15; // degrees per click of the rotate buttons
const DICE_KEY = "vtt:dice3d";
const SNAP_KEY = "vtt:snap";
const GRID_KEY = "vtt:grid";
const HINT_KEY = "vtt:hint";
const NAMES_KEY = "vtt:names";
const SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const D3_SIDES = [4, 6, 8, 10, 12, 20];
const MAX_3D_DICE = 10;
// The three ruler buttons on the map. If your circle picture is named cicle-ruler.webp, change its path here.
const RULER_BUTTONS = [
  { id: "line", label: "Line ruler", src: "/assets/ruler.webp" },
  { id: "circle", label: "Circle ruler", src: "/assets/circle-ruler.webp" },
  { id: "range", label: "Distance ranges (Melee, Very close, Close, Far)", src: "/assets/far-ruler.webp" },
] as const;
const TOOL_HELP = {
  line: "Line ruler: drag on the map. Start or end on a token to snap to it.",
  circle: "Circle ruler: drag outward from the center. Start on a token to center on it.",
  range: "Ranges: tap a token (or any spot) to show Melee, Very close, Close and Far.",
} as const;
const TIER_NAMES: Record<Tier, string> = { free: "Free", basic: "Basic", pro: "Pro", master: "Master" };
const fmtMb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const PANEL_W = 460; // width of the side panel on laptop screens

const floating: CSSProperties = {
  background: "#fff", border: "1px solid #bbb", borderRadius: 10, boxShadow: "0 6px 24px #0005",
};
const TAB_ICONS: Record<Tab, { src: string; label: string }> = {
  token: { src: "/assets/user.webp", label: "My token" },
  chat: { src: "/assets/chat.webp", label: "Chat" },
  tokens: { src: "/assets/user.webp", label: "Tokens" },
  invite: { src: "/assets/invitelink.webp", label: "Invite players" },
  settings: { src: "/assets/gearsettings.webp", label: "Settings" },
  library: { src: "/assets/library.svg", label: "Library" },
  initiative: { src: "/assets/sword.webp", label: "Initiative" },
};

// The action buttons shown for a selected token. What each one does comes later.
const TOKEN_ACTIONS = [
  { id: "sword", label: "Melee Attack", src: "/assets/sword.webp" },
  { id: "bow", label: "Ranged Attack", src: "/assets/bowarrow.webp" },
  { id: "spell", label: "Spellbook", src: "/assets/spellbook.webp" },
  { id: "potion", label: "Potion", src: "/assets/potionbottle.webp" },
] as const;
type ActionId = (typeof TOKEN_ACTIONS)[number]["id"];
// Ammo for the Ranged Attack. The pictures point up; size is in map pixels.
const AMMO_TYPES = [
  { id: "arrow", label: "Arrow / Bolts", src: "/assets/arrowbolt.webp", size: 56 },
  { id: "gun", label: "Gun Ammo", src: "/assets/gunammo.webp", size: 22 },
] as const;
type AmmoId = (typeof AMMO_TYPES)[number]["id"];

// A temporary ammo token in flight (never saved; it only exists on screen)
type Shot = {
  id: string; ammo: AmmoId; sx: number; sy: number; ex: number; ey: number;
  angle: number; ms: number; go: boolean;
};

// A tab shown as an icon only. The name appears as a tooltip.
function IconTab({
  id, variant, size, active, badge, stretch, onClick,
}: {
  id: Tab; variant: "tab" | "dock"; size: number; active?: boolean; badge?: number; stretch?: boolean;
  onClick: () => void;
}) {
  const t = TAB_ICONS[id];
  const base: CSSProperties = {
    position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center",
    padding: 0, cursor: "pointer",
  };
  const style: CSSProperties =
    variant === "dock"
      ? { ...base, ...floating, width: size + 20, height: size + 20, borderRadius: "50%" }
      : {
          ...base, height: size + 16, border: "none",
          ...(stretch ? { flex: 1, minWidth: 0 } : { width: size + 22 }),
          borderBottom: `3px solid ${active ? "#222" : "transparent"}`,
          borderRadius: "6px 6px 0 0", background: active ? "#ececec" : "transparent",
        };
  return (
    <button onClick={onClick} title={t.label} aria-label={t.label} style={style}>
      {/* multiply makes a white picture background see-through */}
      <img
        src={t.src} alt="" width={size} height={size} draggable={false}
        style={{ display: "block", mixBlendMode: "multiply", pointerEvents: "none" }}
      />
      {badge ? (
        <span
          style={{
            position: "absolute", top: 0, right: 0, background: "#e74c3c", color: "#fff", borderRadius: 9,
            fontSize: 10, minWidth: 16, height: 16, lineHeight: "16px", textAlign: "center",
          }}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

// Find: centers the map on a token. Shown as an icon to save space.
function FindButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Find token"
      aria-label="Find token"
      style={{
        padding: 3, width: 30, height: 28, cursor: "pointer",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <img
        src="/assets/findtoken.webp" alt="" width={20} height={20} draggable={false}
        style={{ mixBlendMode: "multiply", pointerEvents: "none" }}
      />
    </button>
  );
}

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
  m.kind === "action"
    ? m.text ?? ""
    : m.kind === "roll" && m.roll
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
  const [newHidden, setNewHidden] = useState(false);
  const [inviteHours, setInviteHours] = useState(24);
  const [inviteUses, setInviteUses] = useState(6);
  const [inviteError, setInviteError] = useState("");
  const [squaresDraft, setSquaresDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [dice3d, setDice3d] = useState(() => loadFlag(DICE_KEY, true));
  const [snap, setSnap] = useState(() => loadFlag(SNAP_KEY, true));
  const [showGrid, setShowGrid] = useState(() => loadFlag(GRID_KEY, true));
  const [showNames, setShowNames] = useState(() => loadFlag(NAMES_KEY, false));

  // panel and menu
  const [open, setOpen] = useState(isGm); // GM starts with the panel open, players with it closed
  const [tab, setTab] = useState<Tab>(isGm ? "tokens" : "token");
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<{ tokenId: string; id: ActionId } | null>(null);
  const [picker, setPicker] = useState<{ sourceId: string; actionId: ActionId; ammo?: AmmoId } | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [shaking, setShaking] = useState<Record<string, boolean>>({}); // tokens that are shaking from a hit
  const [rollPopup, setRollPopup] = useState<{ id: string; who: string; roll: Roll; note: string } | null>(null);
  const popupTimer = useRef<number | undefined>(undefined);
  const [lastOwn, setLastOwn] = useState(-1); // which of my tokens "My token" went to last
    // GM library: maps and saved tokens
  const [maps, setMaps] = useState<MapSummary[]>(init.maps ?? []);
  const [activeMapId, setActiveMapId] = useState(init.activeMapId ?? "");
  const [tier, setTier] = useState<TierInfo | null>(init.tier ?? null);
  const [library, setLibrary] = useState<SavedToken[]>(init.library ?? []);
  const [newMapName, setNewMapName] = useState("");
  const [libNote, setLibNote] = useState("");
  const libTimer = useRef<number | undefined>(undefined);
    // Initiative tracker
  const [initiative, setInitiative] = useState<InitiativeState>(init.initiative);
  const [initDismissed, setInitDismissed] = useState(0); // start time of the roll popup the player closed
  const [initAddId, setInitAddId] = useState("");
    // Rulers
  const [tool, setTool] = useState<Tool>("none");
  const [ruler, setRuler] = useState<Ruler | null>(null);
  const [measure, setMeasure] = useState<Measure>(init.measure);
  const [measureDraft, setMeasureDraft] = useState<Partial<Record<keyof Measure, string>>>({});
  const [measureNote, setMeasureNote] = useState("");
    const [diceOpen, setDiceOpen] = useState(false); // the floating dice pad

    const [newSave, setNewSave] = useState(true); // also save new tokens to the library
  const [thumbTick, setThumbTick] = useState(0);
  const thumbsTried = useRef(new Set<string>());
  const thumbBusy = useRef(false);
  const [tweens, setTweens] = useState<Record<string, number>>({}); // token id -> glide time in ms
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState<Msg | null>(null);
  const [hint, setHint] = useState(() => !isGm && loadFlag(HINT_KEY, true));

  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLSpanElement | null>(null);
  const mapFileRef = useRef<HTMLInputElement>(null);
  const tokenFileRef = useRef<HTMLInputElement>(null);
  const tokenUploadId = useRef<string | null>(null);
  const mapUploadId = useRef<string | null>(null); // which map the picture file picker is for
  const view = useRef<View>({ x: 20, y: 20, z: 1 });
  const dims = useRef<Dims>({ w: init.map.w, h: init.map.h });
  const lastImage = useRef(init.map.image);
  const pointers = useRef(new Map<number, Pt>());
  const gesture = useRef<Gesture>(null);
  const dragPos = useRef<Pt | null>(null);
  const lastEmit = useRef(0);
  const lastTap = useRef<{ id: string; t: number } | null>(null); // for double-click detection on tokens
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
  // Lowest layer first, so higher layers are drawn on top
  const byLayer = [...Object.values(tokens)].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

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

  const tabs: Tab[] = isGm
    ? ["chat", "initiative", "tokens", "library", "invite", "settings"]
    : ["token", "chat", "initiative", "settings"];

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
    if (layerRef.current) {
      layerRef.current.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
      layerRef.current.style.setProperty("--inv", String(1 / v.z)); // ruler lines and labels keep their on-screen size
    }
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
      localStorage.setItem(NAMES_KEY, showNames ? "on" : "off");
    } catch {
      /* ignore */
    }
  }, [snap, showGrid, showNames]);

  // ---------- 3D dice layer ----------
  useEffect(() => {
    let cancelled = false;
    const layer = document.getElementById("dice-layer");
    (async () => {
      try {
                // Smaller dice on phones (baseScale is the dice size, 100 = normal)
        const small = window.matchMedia("(max-width: 700px)").matches;
        const box: DiceBoxLike = new DiceBox("#dice-layer", {
          sounds: false, theme_colorset: "white", baseScale: small ? 50 : 100,
        });
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

  // GM: make small previews for maps that have a picture but no preview yet (also for older maps)
  useEffect(() => {
    if (!isGm || thumbBusy.current) return;
    const m = maps.find((x) => x.image && !x.thumb && !thumbsTried.current.has(`${x.id}|${x.image}`));
    if (!m || !m.image) return;
    const url = m.image;
    thumbsTried.current.add(`${m.id}|${url}`);
    thumbBusy.current = true;
    (async () => {
      try {
        const blob = await prepareThumb(url);
        await upload("thumb", blob, { mapId: m.id });
      } catch {
        /* the preview just stays empty */
      }
      thumbBusy.current = false;
      setThumbTick((n) => n + 1); // look for the next map without a preview
    })();
  }, [maps, isGm, thumbTick]);
    // Esc: stop the ruler tool and clear the measurement
  const rulerActive = tool !== "none" || !!ruler;
  useEffect(() => {
    if (!rulerActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setTool("none");
        setRuler(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rulerActive]);
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
        // A token glides to a new spot (for example a melee attack): the same straight-line move on every screen
    socket.on("tween", ({ id, x, y, ms }: { id: string; x: number; y: number; ms: number }) => {
      setTweens((all) => ({ ...all, [id]: ms }));
      setTokens((all) => (all[id] ? { ...all, [id]: { ...all[id], x, y } } : all));
      window.setTimeout(
        () =>
          setTweens((all) => {
            const next = { ...all };
            delete next[id];
            return next;
          }),
        ms + 60
      );
    });
        // A shot flies from one token to another and disappears on impact
    socket.on("projectile", (p: Omit<Shot, "go">) => {
      setShots((all) => [...all, { ...p, go: false }]);
      // Start the flight two frames later so the browser animates it
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() =>
          setShots((all) => all.map((s) => (s.id === p.id ? { ...s, go: true } : s)))
        )
      );
      window.setTimeout(() => setShots((all) => all.filter((s) => s.id !== p.id)), p.ms + 100);
    });
        // The target of an attack shakes a little when the hit lands (its real position does not change)
    socket.on("hit", ({ id, delay }: { id: string; delay: number }) => {
      window.setTimeout(() => {
        setShaking((all) => ({ ...all, [id]: true }));
        window.setTimeout(
          () =>
            setShaking((all) => {
              const next = { ...all };
              delete next[id];
              return next;
            }),
          450
        );
      }, delay + 30);
    });

        // GM library
    socket.on("maps", (d: MapsPayload) => {
      setMaps(d.maps);
      setActiveMapId(d.activeMapId);
      setTier(d.tier);
    });
    socket.on("library", setLibrary);
    socket.on("initiative", setInitiative);
        socket.on("measure", setMeasure);
    socket.on("chatCleared", () => {
      setMessages([]);
      setUnread(0);
      setToast(null);
      setRollPopup(null);
    });
    // The GM opened another map: everyone gets its picture and tokens
    socket.on("scene", ({ map: m, tokens: t }: { map: MapInfo; tokens: Record<string, Token> }) => {
      dims.current = { w: m.w, h: m.h };
      lastImage.current = m.image;
      setMap(m);
      setTokens(t);
      setSelectedId(null);
      setAction(null);
      setPicker(null);
      setShots([]);
      setShaking({});
      setTweens({});
      setRuler(null);
      fitMap();
    });
    
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
                // A roll: show the total in a popup once the dice have settled
        if (m.kind === "roll" && m.roll) {
          const note =
            m.to === null ? "" : m.fromId === me.id && m.to.length === 1 && m.to[0] === me.id ? "secret roll" : "whisper";
          setRollPopup({ id: m.id, who: m.fromName, roll: m.roll, note });
          window.clearTimeout(popupTimer.current);
          popupTimer.current = window.setTimeout(() => setRollPopup(null), 4000);
        }
        // Someone else's message while the chat is not on screen: unread count and a short pop-up
        // (rolls already have their own popup)
        if (m.fromId !== me.id && !chatVisible.current) {
          setUnread((u) => u + 1);
          if (m.kind !== "roll") {
            setToast(m);
            window.clearTimeout(toastTimer.current);
            toastTimer.current = window.setTimeout(() => setToast(null), 6000);
          }
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
      socket.off("tween");
      socket.off("projectile");
      socket.off("hit");
      socket.off("maps");
      socket.off("library");
      socket.off("initiative");
      socket.off("measure");
      socket.off("chatCleared");
      socket.off("scene");
      socket.off("chat");
    };
  }, [applyView, fitMap, me.id]);

  // ---------- pointer handling: tap, hover, drag token, pan, pinch ----------
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
    // ---------- rulers ----------
  const tokenCenter = (t: Token): Pt => ({ x: t.x + (t.size * CELL) / 2, y: t.y + (t.size * CELL) / 2 });

  // With "Snap to grid" on, ruler points go to the middle of a square
  const snapPoint = (m: Pt): Pt => {
    const d = dims.current;
    const x = clamp(m.x, 0, d.w);
    const y = clamp(m.y, 0, d.h);
    if (!snap) return { x, y };
    return {
      x: clamp((Math.floor(x / CELL) + 0.5) * CELL, 0, d.w),
      y: clamp((Math.floor(y / CELL) + 0.5) * CELL, 0, d.h),
    };
  };

  // The token under a screen point (the ruler drawing lets pointer events through)
  const tokenAtPoint = (cx: number, cy: number): Token | undefined => {
    const el = document.elementFromPoint(cx, cy)?.closest("[data-token-id]") as HTMLElement | null;
    return el ? tokens[el.dataset.tokenId ?? ""] : undefined;
  };
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

    // A click on a token you control selects it (name and action buttons).
  // A double click or double tap opens its panel.
  const onTokenTap = (id: string) => {
    const now = Date.now();
    const last = lastTap.current;
    if (last && last.id === id && now - last.t < 400) {
      lastTap.current = null;
      setSelectedId(id);
      openTab(isGm ? "tokens" : "token");
    } else {
      lastTap.current = { id, t: now };
      setSelectedId(id);
    }
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
        // A ruler tool is on: dragging draws a measurement (hold Shift to pan or move tokens as usual)
    if (tool !== "none" && !e.shiftKey) {
      const t = tokenAtPoint(e.clientX, e.clientY);
      const spot = snapPoint(toMap(p));
      if (tool === "range") {
        // One tap: rings around a token (they follow it) or around a spot
        setRuler(
          t
            ? { kind: "range", tokenId: t.id, ax: 0, ay: 0, bx: 0, by: 0 }
            : { kind: "range", ax: spot.x, ay: spot.y, bx: spot.x, by: spot.y }
        );
        gesture.current = null;
        return;
      }
      const a = t ? tokenCenter(t) : spot;
      setRuler({ kind: tool, ax: a.x, ay: a.y, bx: a.x, by: a.y });
      gesture.current = { kind: "measure", tool };
      return;
    }

    const el = (e.target as HTMLElement).closest("[data-token-id]") as HTMLElement | null;
    const t = el ? tokens[el.dataset.tokenId ?? ""] : undefined;
    if (t) setSelectedId(t.id); // a pressed token keeps its name visible
    if (t && canMove(t)) {
      const m = toMap(p);
      dragPos.current = null;
      gesture.current = { kind: "token", id: t.id, dx: m.x - t.x, dy: m.y - t.y, sx: p.x, sy: p.y, moved: false };
    } else {
      gesture.current = {
        kind: "pan", sx: p.x, sy: p.y, vx: view.current.x, vy: view.current.y, moved: false, tap: t?.id,
      };
    }
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    // Mouse hover (no button pressed): remember which token is under the pointer
    if (e.pointerType === "mouse" && e.buttons === 0) {
      const el = (e.target as HTMLElement).closest("[data-token-id]") as HTMLElement | null;
      const id = el?.dataset.tokenId ?? null;
      setHoverId((cur) => (cur === id ? cur : id));
    }
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
    if (g.kind === "measure") {
      const t = tokenAtPoint(e.clientX, e.clientY);
      const b = t ? tokenCenter(t) : snapPoint(toMap(p));
      setRuler((r) => (r && r.kind === g.tool ? { ...r, bx: b.x, by: b.y } : r));
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
    } else if (g?.kind === "pan" && !g.moved) {
      if (g.tap) {
        setSelectedId(g.tap); // tap on a token you cannot move: show its name
      } else {
        setSelectedId(null); // tap on empty map
        setAction(null);
        if (!isGm) setOpen(false); // players: also closes the panel
      }
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

  // Rotate / flip the picture of a token
  const look = (t: Token, patch: { rot?: number; flip?: boolean }) => {
    const rot = patch.rot === undefined ? undefined : ((Math.round(patch.rot) % 360) + 360) % 360;
    setTokens((all) =>
      all[t.id] ? { ...all, [t.id]: { ...all[t.id], rot: rot ?? all[t.id].rot, flip: patch.flip ?? all[t.id].flip } } : all
    );
    socket.emit("setLook", { id: t.id, rot, flip: patch.flip });
  };

  // New tokens appear in the middle of the part of the map the GM can see
    // Middle of the part of the map the GM can see, for a token of this size
    const spawnPoint = (size: number): Pt => {
      const { w, h } = vpSize();
      let sx = w / 2;
      let sy = h / 2;
      if (open) {
        if (narrow) sy = (h * 0.42) / 2;
        else sx = Math.max(100, (w - (PANEL_W + 12)) / 2);
      }
      const v = view.current;
      const cx = (sx - v.x) / v.z;
      const cy = (sy - v.y) / v.z;
      return snapPos(dims.current, size, cx - (size * CELL) / 2, cy - (size * CELL) / 2);
    };

  const addToken = () => {
    const s = spawnPoint(newSize);
    socket.emit("addToken", {
      label: newLabel, color: newColor, size: newSize, ownerId: newOwner || null,
      hp: newHp, maxHp: newHp, x: s.x, y: s.y, hidden: newHidden, save: newSave,
    });
    setNewLabel("");
  };

    // Apply the "squares across" number of one map (the picture keeps its shape)
  const applySquares = (m: MapSummary) => {
    const n = Number(squaresDraft[m.id] ?? Math.round(m.w / CELL));
    socket.emit("setMap", { id: m.id, ...sizeFor(n, m.h / m.w) });
    setSquaresDraft((d) => {
      const next = { ...d };
      delete next[m.id];
      return next;
    });
  };

  const onMapFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const mapId = mapUploadId.current;
    if (!file || !mapId) return;
    setBusy("Uploading map picture...");
    setUploadError("");
    try {
      const p = await prepareMap(file);
      // Guess the grid: most battle maps use about 70 px per square
      const size = sizeFor(Math.round(p.width / 70), p.height / p.width);
      const err = await upload("map", p.blob, { ...size, mapId });
      if (err) {
        setUploadError(err);
      } else {
        setSquaresDraft((d) => {
          const next = { ...d };
          delete next[mapId];
          return next;
        });
      }
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

  const removePlayer = (id: string, name: string) => {
    if (
      !window.confirm(
        `Remove ${name} from the table?\n\nTheir token(s) stay on the map and go back to you. ` +
          `To stop them joining again, also revoke the invite link they used.`
      )
    ) {
      return;
    }
    socket.emit("removePlayer", { id });
  };

    // ---------- library: maps and saved tokens ----------
  const flash = (text: string) => {
    setLibNote(text);
    window.clearTimeout(libTimer.current);
    libTimer.current = window.setTimeout(() => setLibNote(""), 3500);
  };

  const mapsFull = !!tier && tier.mapCount >= tier.maxMaps;

  const createMap = () => {
    socket.emit("createMap", { name: newMapName }, (r: { ok?: boolean; error?: string }) => {
      if (r?.ok) setNewMapName("");
      else flash(r?.error ?? "Could not add the map");
    });
  };

  const openMap = (m: MapSummary) => {
    if (m.id === activeMapId) return;
    if (!window.confirm(`Switch everyone to "${m.name}" now? Players will see this map right away.`)) return;
    socket.emit("activateMap", m.id);
  };

  const deleteMap = (m: MapSummary) => {
    if (!window.confirm(`Delete the map "${m.name}" with all its tokens and its picture? This cannot be undone.`)) return;
    socket.emit("deleteMap", m.id, (r: { ok?: boolean; error?: string }) => {
      if (!r?.ok) flash(r?.error ?? "Could not delete the map");
    });
  };

  const saveToLibrary = (t: Token) =>
    socket.emit("saveToken", { id: t.id }, (r: { ok?: boolean; error?: string }) =>
      flash(r?.ok ? `"${t.label}" saved to the library` : r?.error ?? "Could not save the token")
    );

  const addFromLibrary = (s: SavedToken) => {
    const p = spawnPoint(s.size);
    socket.emit("libraryAdd", { id: s.id, x: p.x, y: p.y });
    flash(`"${s.label}" added to the map`);
  };

    // GM: delete all chat messages for everyone
  const clearChat = () => {
    if (!window.confirm("Clear the whole chat for everyone? This cannot be undone.")) return;
    socket.emit("clearChat");
  };
    // ---------- initiative ----------
  const startInitiative = () => {
    if (
      initiative.active &&
      !window.confirm("Restart initiative? All values are cleared and the players are asked to roll again.")
    ) {
      return;
    }
    socket.emit("initiativeStart");
  };

  const endInitiative = () => {
    if (!window.confirm("End initiative and clear the list?")) return;
    socket.emit("initiativeEnd");
  };

  // GM: a value typed by hand (empty = no value)
  const setInitValue = (tokenId: string, text: string, current: number | null) => {
    const v = text.trim() === "" ? null : Number(text);
    if (v !== null && Number.isNaN(v)) return;
    if (v !== current) socket.emit("initiativeSet", { tokenId, value: v });
  };

  // Highest first; tokens without a value at the end
  const initRows = [...initiative.entries]
    .filter((e) => tokens[e.tokenId])
    .sort(
      (a, b) =>
        (b.value ?? -Infinity) - (a.value ?? -Infinity) ||
        tokens[a.tokenId].label.localeCompare(tokens[b.tokenId].label)
    );
  const notInList = Object.values(tokens).filter((t) => !initiative.entries.some((e) => e.tokenId === t.id));
  // Players: their own tokens that still need a roll
  const myPending =
    !isGm && initiative.active
      ? initiative.entries.filter((e) => e.value === null && tokens[e.tokenId]?.ownerId === me.id)
      : [];
  const showInitPopup = myPending.length > 0 && initDismissed !== initiative.startedAt;
    // ---------- ruler drawing ----------
  const ftPerPx = measure.ftPerSquare / CELL;
  // A size that stays the same on screen at any zoom (--inv is 1 / zoom, set on the map layer)
  const sc = (n: number) => `calc(${n}px * var(--inv, 1))`;
  const labelStyle: CSSProperties = {
    fontSize: sc(15), fontWeight: 700, fill: "#1b1b1b", stroke: "#fff", strokeWidth: sc(4),
    paintOrder: "stroke", strokeLinejoin: "round",
  };
  const dot = (x: number, y: number, color: string) => (
    <line x1={x} y1={y} x2={x + 0.01} y2={y} stroke={color} strokeLinecap="round" style={{ strokeWidth: sc(11) }} />
  );

  const rulerSvg = (() => {
    if (!ruler) return null;

    if (ruler.kind === "line") {
      const len = Math.hypot(ruler.bx - ruler.ax, ruler.by - ruler.ay);
      return (
        <>
          <line
            x1={ruler.ax} y1={ruler.ay} x2={ruler.bx} y2={ruler.by}
            stroke="#d4380d" strokeLinecap="round" style={{ strokeWidth: sc(3) }}
          />
          {dot(ruler.ax, ruler.ay, "#d4380d")}
          {dot(ruler.bx, ruler.by, "#d4380d")}
          <text x={(ruler.ax + ruler.bx) / 2} y={(ruler.ay + ruler.by) / 2} dy="-0.7em" textAnchor="middle" style={labelStyle}>
            {Math.round(len * ftPerPx)} ft ({(len / CELL).toFixed(1)} sq)
          </text>
        </>
      );
    }

    if (ruler.kind === "circle") {
      const rad = Math.hypot(ruler.bx - ruler.ax, ruler.by - ruler.ay);
      return (
        <>
          <circle
            cx={ruler.ax} cy={ruler.ay} r={rad} fill="#3498db" fillOpacity={0.16}
            stroke="#2471a3" style={{ strokeWidth: sc(2.5) }}
          />
          <line
            x1={ruler.ax} y1={ruler.ay} x2={ruler.bx} y2={ruler.by}
            stroke="#2471a3" strokeLinecap="round" style={{ strokeWidth: sc(2) }}
          />
          {dot(ruler.ax, ruler.ay, "#2471a3")}
          <text x={(ruler.ax + ruler.bx) / 2} y={(ruler.ay + ruler.by) / 2} dy="-0.7em" textAnchor="middle" style={labelStyle}>
            {Math.round(rad * ftPerPx)} ft radius
          </text>
        </>
      );
    }

    // Ranges: rings around a token (measured from its edge) or around a spot
    const t = ruler.tokenId ? tokens[ruler.tokenId] : undefined;
    if (ruler.tokenId && !t) return null;
    const c = t ? tokenCenter(t) : { x: ruler.ax, y: ruler.ay };
    const base = t ? (t.size * CELL) / 2 : 0;
    const bands = [
      { name: "Far", ft: measure.far, color: "#e74c3c" },
      { name: "Close", ft: measure.close, color: "#e67e22" },
      { name: "Very close", ft: measure.veryClose, color: "#d4ac0d" },
      { name: "Melee", ft: measure.melee, color: "#27ae60" },
    ];
    return (
      <>
        {bands.map((b) => {
          const r = base + b.ft / ftPerPx;
          return (
            <g key={b.name}>
              <circle cx={c.x} cy={c.y} r={r} fill={b.color} fillOpacity={0.12} stroke={b.color} style={{ strokeWidth: sc(2.5) }} />
              <text x={c.x} y={c.y - r} dy="-0.45em" textAnchor="middle" style={labelStyle}>
                {b.name} {b.ft} ft
              </text>
            </g>
          );
        })}
      </>
    );
  })();

  // GM: Measurement settings
  const mVal = (k: keyof Measure) => measureDraft[k] ?? String(measure[k]);
  const saveMeasure = () => {
    setMeasureNote("");
    socket.emit(
      "setMeasure",
      {
        ftPerSquare: Number(mVal("ftPerSquare")), melee: Number(mVal("melee")), veryClose: Number(mVal("veryClose")),
        close: Number(mVal("close")), far: Number(mVal("far")),
      },
      (r: { ok?: boolean; error?: string }) => {
        if (r?.ok) {
          setMeasureDraft({});
          setMeasureNote("Saved");
        } else {
          setMeasureNote(r?.error ?? "Could not save");
        }
      }
    );
  };
  const hpColor = (t: Token) => {
    const pct = (t.hp ?? 0) / (t.maxHp || 1);
    return pct > 0.5 ? "#2ecc71" : pct > 0.25 ? "#f1c40f" : "#e74c3c";
  };
    // "My token" in the menu: go to my first token, press again for the next one, then back to the first
  const cycleOwnToken = () => {
    if (ownTokens.length === 0) return;
    const next = (lastOwn + 1) % ownTokens.length;
    setLastOwn(next);
    centerOn(ownTokens[next]);
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

  // Rotate and flip buttons (only for tokens that have a picture)
  const lookControls = (t: Token) =>
    t.image ? (
      <div style={{ ...row, marginTop: 6 }}>
        <button onClick={() => look(t, { rot: (t.rot ?? 0) - ROTATE_STEP })} title="Rotate left">↺</button>
        <span style={{ fontSize: 12, minWidth: 36, textAlign: "center" }}>{t.rot ?? 0}°</span>
        <button onClick={() => look(t, { rot: (t.rot ?? 0) + ROTATE_STEP })} title="Rotate right">↻</button>
        <button onClick={() => look(t, { flip: !t.flip })}>Flip</button>
        <button onClick={() => look(t, { rot: 0, flip: false })}>Reset</button>
      </div>
    ) : null;

  const showInfo = (t: Token) => showNames || t.id === hoverId || t.id === selectedId;

  const show = (t: Tab): CSSProperties => ({ display: tab === t ? "block" : "none" });
  const cardStyle = (id: string): CSSProperties => ({
    border: id === selectedId ? "2px solid #f1c40f" : "1px solid #ddd",
    borderRadius: 8, padding: 10, marginBottom: 8,
  });

  const panelPos: CSSProperties = narrow
    ? { left: 0, right: 0, bottom: 0, height: "58%", borderRadius: "12px 12px 0 0" }
    : { top: 12, right: 12, width: PANEL_W, height: "calc(100% - 24px)" };

  // Action buttons: the GM can use them on any token, a player only on their own
  const selectedToken = selectedId ? tokens[selectedId] : undefined;
  const actionToken = selectedToken && canMove(selectedToken) ? selectedToken : undefined;

    // Smooth glide while a token is being moved by an action
  const tweenCss = (id: string) =>
    tweens[id] ? `left ${tweens[id]}ms ease-in-out, top ${tweens[id]}ms ease-in-out` : undefined;

  const closePicker = () => {
    setPicker(null);
    setAction(null); // cancels the whole process
  };

  const onTokenAction = (id: ActionId) => {
    if (!actionToken) return;
    if (id === "sword" || id === "bow") {
      setAction({ tokenId: actionToken.id, id });
      setPicker({ sourceId: actionToken.id, actionId: id }); // Ranged Attack asks for the ammo first
      return;
    }
    setAction((cur) =>
      cur && cur.tokenId === actionToken.id && cur.id === id ? null : { tokenId: actionToken.id, id }
    );
  };

  // Ranged Attack, step 1: the ammo is chosen, then the target list opens
  const chooseAmmo = (ammo: AmmoId) => setPicker((cur) => (cur ? { ...cur, ammo } : cur));

  // A target was chosen: send it, then clear the screen so the movement or shot can be seen
  const chooseTarget = (target: Token) => {
    if (!picker) return;
    socket.emit("tokenAction", {
      from: picker.sourceId, to: target.id, action: picker.actionId, ammo: picker.ammo,
    });
    setPicker(null);
    setAction(null);
    setSelectedId(null); // hides the action buttons
    setMenuOpen(false);
    setOpen(false); // minimizes the panel
  };

  const pickerSource = picker ? tokens[picker.sourceId] : undefined;
  const pickerAction = picker ? TOKEN_ACTIONS.find((a) => a.id === picker.actionId) : undefined;
  const pickerAmmo = picker && picker.ammo ? AMMO_TYPES.find((a) => a.id === picker.ammo) : undefined;
  const needAmmo = !!picker && picker.actionId === "bow" && !picker.ammo;
  const targets =
    picker && !needAmmo
      ? Object.values(tokens)
          .filter((t) => t.id !== picker.sourceId)
          .sort((a, b) => a.label.localeCompare(b.label))
      : [];

  // Esc closes the popup
  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPicker(null);
        setAction(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker]);

  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", fontFamily: "sans-serif", background: "#222" }}>
            <style>{`
        @keyframes vttShake {
          0%, 100% { transform: translate(0, 0); }
          15% { transform: translate(-8%, 3%); }
          30% { transform: translate(8%, -3%); }
          45% { transform: translate(-6%, -2%); }
          60% { transform: translate(6%, 2%); }
          75% { transform: translate(-3%, 0); }
          90% { transform: translate(3%, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-token-id] { animation: none !important; }
        }
      `}</style>
      {/* ---------- full screen map ---------- */}
      <div
        ref={viewportRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHoverId(null)}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          position: "absolute", inset: 0, overflow: "hidden", background: "#3a3a3a",
          touchAction: "none", userSelect: "none", cursor: tool !== "none" ? "show" : "grab",
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

          {/* token pictures, drawn in layer order */}
          {byLayer.map((t) => (
            <div
              key={t.id}
              data-token-id={t.id}
              style={{
                position: "absolute", left: t.x, top: t.y, width: t.size * CELL, height: t.size * CELL,
                zIndex: t.z ?? 0, opacity: t.hidden ? 0.45 : 1, cursor: canMove(t) ? "pointer" : "default",
                transition: tweenCss(t.id),
                animation: shaking[t.id] ? "vttShake 0.4s ease-in-out" : undefined,
              }}
            >
              <div
                style={{
                  width: "100%", height: "100%", borderRadius: t.image ? 0 : "50%", boxSizing: "border-box",
                  background: t.image ? `url(${t.image}) center / contain no-repeat` : t.color,
                  border: t.image
                    ? "none"
                    : `3px ${t.hidden ? "dashed" : "solid"} ${
                        t.ownerId === null ? "#222" : t.ownerId === me.id ? "#f1c40f" : "#fff"
                      }`,
                  outline: t.hidden ? "2px dashed #fff" : "none",
                  outlineOffset: 1,
                  transform: t.image ? `rotate(${t.rot ?? 0}deg) scaleX(${t.flip ? -1 : 1})` : undefined,
                  transition: "transform .15s",
                }}
              />
            </div>
          ))}

          {/* names and HP bars: only for the hovered / selected token (or all, if chosen) */}
          {byLayer.filter(showInfo).map((t) => (
            <div
              key={`info-${t.id}`}
              style={{
                position: "absolute", left: t.x + (t.size * CELL) / 2, top: t.y + t.size * CELL + 2,
                transform: "translateX(-50%)", zIndex: 100000, pointerEvents: "none",
                display: "flex", flexDirection: "column", alignItems: "center", gap: 2, transition: tweenCss(t.id),
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
                {t.hidden ? " (hidden)" : ""}
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
          ))}
          {/* temporary ammo tokens in flight */}
          {shots.map((s) => {
            const a = AMMO_TYPES.find((x) => x.id === s.ammo);
            if (!a) return null;
            return (
              <img
                key={s.id}
                src={a.src}
                alt=""
                width={a.size}
                height={a.size}
                draggable={false}
                style={{
                  position: "absolute", zIndex: 99999, pointerEvents: "none", mixBlendMode: "multiply",
                  left: (s.go ? s.ex : s.sx) - a.size / 2,
                  top: (s.go ? s.ey : s.sy) - a.size / 2,
                  // The pictures point up, so +90 turns "up" toward the direction of flight
                  transform: `rotate(${s.angle + 90}deg)`,
                  transition: s.go ? `left ${s.ms}ms ease-in, top ${s.ms}ms ease-in` : "none",
                }}
              />
            );
          })}
          {/* rulers (only you see them) */}
          {rulerSvg && (
            <svg
              width={map.w} height={map.h}
              style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", zIndex: 99997, overflow: "visible" }}
            >
              {rulerSvg}
            </svg>
          )}
        </div>
        {/* 3D dice are drawn over the visible area, not the whole map; clicks pass through */}
        <div id="dice-layer" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 50 }} />
      </div>

                 {/* ---------- ruler buttons and dice button ---------- */}
      <div style={{ position: "absolute", top: 62, left: 12, zIndex: 95, display: "flex", flexDirection: "column", gap: 8 }}>
        {RULER_BUTTONS.map((b) => {
          const on = tool === b.id;
          return (
            <button
              key={b.id}
              title={b.label}
              aria-label={b.label}
              onClick={() => {
                setMenuOpen(false);
                setTool((cur) => (cur === b.id ? "none" : b.id));
              }}
              style={{
                ...floating, width: 40, height: 40, borderRadius: "50%", padding: 0, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                border: on ? "3px solid #f1c40f" : "1px solid #bbb", background: on ? "#fff6cc" : "#fff",
              }}
            >
              <img
                src={b.src} alt="" width={22} height={22} draggable={false}
                style={{ mixBlendMode: "multiply", pointerEvents: "none" }}
              />
            </button>
          );
        })}
        <button
          title="Dice"
          aria-label="Dice"
          onClick={() => {
            setMenuOpen(false);
            setDiceOpen((v) => !v);
          }}
          style={{
            ...floating, width: 40, height: 40, borderRadius: "50%", padding: 0, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            border: diceOpen ? "3px solid #f1c40f" : "1px solid #bbb", background: diceOpen ? "#fff6cc" : "#fff",
          }}
        >
          <img
            src="/assets/dice.webp" alt="" width={22} height={22} draggable={false}
            style={{ mixBlendMode: "multiply", pointerEvents: "none" }}
          />
        </button>
      </div>

      {/* ---------- the dice pad (opens from the dice button) ---------- */}
      {diceOpen && (
        <div
          style={{
            ...floating, position: "absolute", top: 206, left: 62, zIndex: 96, padding: 10,
            width: "min(340px, calc(100% - 74px))", maxHeight: "calc(100% - 218px)", overflowY: "auto",
          }}
        >
          <div style={{ ...row, justifyContent: "space-between", marginBottom: 6 }}>
            <b>Dice</b>
            <button onClick={() => setDiceOpen(false)} aria-label="Close the dice pad">✕</button>
          </div>
          <ChatPanel
            mode="dice" me={me} members={members} messages={messages} dice3d={dice3d} onDice3d={setDice3d}
            onRoll={() => {
              // On phones, clear the screen so the dice can be seen
              if (narrow) {
                setDiceOpen(false);
                setOpen(false);
                setMenuOpen(false);
              }
            }}
          />
        </div>
      )}

      {/* ---------- ruler tool bar: on while a tool is on or a drawing is on the map ---------- */}
      {(tool !== "none" || ruler) && (
        <div
          style={{
            ...floating, position: "absolute", top: 12, left: 62, zIndex: 100, padding: "8px 10px", fontSize: 13,
            maxWidth: `calc(100% - ${open && !narrow ? PANEL_W + 100 : 74}px)`,
            display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
          }}
        >
          <span>{tool !== "none" ? TOOL_HELP[tool] : "A measurement is on the map."}</span>
          <button onClick={() => setTool("none")} disabled={tool === "none"}>Stop</button>
          <button onClick={() => setRuler(null)} disabled={!ruler}>Clear</button>
        </div>
      )}
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
            {ownTokens.length > 0 && (
              <button onClick={cycleOwnToken} title="Go to my token (press again for the next one)">
                My token
                {ownTokens.length > 1
                  ? lastOwn >= 0
                    ? ` ${Math.min(lastOwn, ownTokens.length - 1) + 1}/${ownTokens.length}`
                    : ` (${ownTokens.length})`
                  : ""}
              </button>
            )}
          </div>
          <label style={{ display: "block", fontSize: 13, marginTop: 8 }}>
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap to grid
          </label>
          <label style={{ display: "block", fontSize: 13 }}>
            <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} /> Show grid
          </label>
          <label style={{ display: "block", fontSize: 13 }}>
            <input type="checkbox" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} /> Show all names
        </label>
          <div style={{ marginTop: 10, fontWeight: 600, fontSize: 13 }}>Measure</div>
          <div style={{ ...row, marginTop: 4 }}>
            <button onClick={() => setRuler(null)} disabled={!ruler}>Clear</button>
          </div>
          {isGm && (
            <div style={{ marginTop: 8 }}>
              <button onClick={() => { setMenuOpen(false); setPwOpen(true); }}>Change password</button>
            </div>
          )}
        </div>
      )}
            {/* ---------- players: roll initiative ---------- */}
      {showInitPopup && (
        <div
          style={{
            ...floating, position: "absolute", left: "50%", transform: "translateX(-50%)", zIndex: 135,
            bottom: narrow && open ? "calc(58% + 12px)" : 16, width: "min(340px, calc(100% - 24px))",
            padding: 14, border: "2px solid #f1c40f",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 17 }}>Roll initiative!</div>
          <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>
            The GM started initiative. Roll a d{initiative.die} for your token{myPending.length > 1 ? "s" : ""}.
          </div>
          {myPending.map((e) => {
            const t = tokens[e.tokenId];
            if (!t) return null;
            return (
              <div key={e.tokenId} style={{ ...row, flexWrap: "nowrap", marginTop: 8 }}>
                <span
                  style={{
                    width: 26, height: 26, flex: "none", border: "1px solid #bbb",
                    borderRadius: t.image ? 4 : "50%",
                    background: t.image ? `url(${t.image}) center / contain no-repeat` : t.color,
                  }}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.label}
                </span>
                <button
                  onClick={() => {
                    socket.emit("initiativeRoll", { tokenId: e.tokenId });
                    if (narrow) {
                      // On phones, clear the screen so the dice can be seen
                      setOpen(false);
                      setMenuOpen(false);
                    }
                  }}
                >
                  Roll d{initiative.die}
                </button>
              </div>
            );
          })}
          <div style={{ marginTop: 10, textAlign: "right" }}>
            <button onClick={() => setInitDismissed(initiative.startedAt)}>Later</button>
          </div>
        </div>
      )}
      {/* ---------- dice result popup ---------- */}
      {rollPopup && (
        <div
          onClick={() => setRollPopup(null)}
          style={{
            ...floating, position: "absolute", left: "50%", top: narrow ? "14%" : "18%",
            transform: "translateX(-50%)", zIndex: 130, padding: "12px 24px", textAlign: "center",
            cursor: "pointer", minWidth: 150, maxWidth: "calc(100% - 32px)",
          }}
        >
          <div style={{ fontSize: 12, color: "#555" }}>
            {rollPopup.who} rolled {rollPopup.roll.formula}
            {rollPopup.note ? ` (${rollPopup.note})` : ""}
          </div>
          <div style={{ fontSize: 48, fontWeight: 700, lineHeight: 1.1 }}>{rollPopup.roll.total}</div>
          <div style={{ fontSize: 12, color: "#777" }}>
            [
            {rollPopup.roll.rolls.map((v, i) => (
              <span
                key={i}
                style={
                  rollPopup.roll.keep && !rollPopup.roll.keep[i]
                    ? { textDecoration: "line-through", color: "#aaa" }
                    : undefined
                }
              >
                {v}
                {i < rollPopup.roll.rolls.length - 1 ? ", " : ""}
              </span>
            ))}
            ]
          </div>
        </div>
      )}
            {/* ---------- action popups: ammo (Ranged Attack only), then target ---------- */}
      {picker && pickerSource && pickerAction && (
        <div
          onClick={closePicker}
          style={{
            position: "absolute", inset: 0, zIndex: 150, background: "#0004",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ ...floating, width: 320, maxWidth: "100%", maxHeight: "70%", display: "flex", flexDirection: "column" }}
          >
            <div style={{ ...row, padding: "10px 12px", borderBottom: "1px solid #ddd" }}>
              <img src={pickerAction.src} alt="" width={22} height={22} style={{ mixBlendMode: "multiply" }} />
              <b style={{ flex: 1 }}>{pickerAction.label}</b>
              <button onClick={closePicker} aria-label="Close">✕</button>
            </div>

            {needAmmo ? (
              <>
                <div style={{ padding: "8px 12px 0", fontSize: 12, color: "#777" }}>
                  {pickerSource.label}: choose the ammo
                </div>
                <div style={{ padding: 8 }}>
                  {AMMO_TYPES.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => chooseAmmo(a.id)}
                      style={{
                        display: "flex", width: "100%", alignItems: "center", gap: 10, textAlign: "left",
                        padding: "8px 10px", marginBottom: 4, cursor: "pointer",
                        border: "1px solid #ddd", borderRadius: 8, background: "#fff",
                      }}
                    >
                      <img src={a.src} alt="" width={28} height={28} style={{ mixBlendMode: "multiply" }} />
                      <span style={{ flex: 1 }}>{a.label}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div style={{ padding: "8px 12px 0", fontSize: 12, color: "#777" }}>
                  {pickerSource.label}: choose a target{pickerAmmo ? ` (${pickerAmmo.label})` : ""}
                </div>
                <div style={{ overflowY: "auto", padding: 8 }}>
                  {targets.length === 0 && <div style={{ color: "#777", padding: 8 }}>There are no other tokens.</div>}
                  {targets.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => chooseTarget(t)}
                      style={{
                        display: "flex", width: "100%", alignItems: "center", gap: 8, textAlign: "left",
                        padding: "8px 10px", marginBottom: 4, cursor: "pointer",
                        border: "1px solid #ddd", borderRadius: 8, background: "#fff",
                      }}
                    >
                      <span
                        style={{
                          width: 16, height: 16, borderRadius: "50%", flex: "none",
                          background: t.image ? `url(${t.image}) center / contain` : t.color,
                        }}
                      />
                      <span style={{ flex: 1 }}>
                        {t.label}
                        {t.hidden ? " (hidden)" : ""}
                      </span>
                      <span style={{ fontSize: 11, color: "#777" }}>{ownerName(t.ownerId)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {/* ---------- token action buttons: shown while one of your tokens is selected ---------- */}
      {actionToken && (
        <div
          style={{
            position: "absolute", left: 0, right: open && !narrow ? PANEL_W + 12 : 0,
            bottom: narrow && open ? "calc(58% + 12px)" : 16, zIndex: 80,
            display: "flex", justifyContent: "center", gap: narrow ? 8 : 10, pointerEvents: "none",
          }}
        >
          {TOKEN_ACTIONS.map((a) => {
            const on = action !== null && action.tokenId === actionToken.id && action.id === a.id;
            const d = narrow ? 56 : 72;
            return (
              <button
                key={a.id}
                title={`${a.label} (${actionToken.label})`}
                aria-label={a.label}
                onClick={() => onTokenAction(a.id)}
                style={{
                  ...floating, pointerEvents: "auto", width: d, height: d, borderRadius: "50%", padding: 0,
                  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  border: on ? "3px solid #f1c40f" : "1px solid #bbb", background: on ? "#fff6cc" : "#fff",
                }}
              >
                <img
                  src={a.src} alt="" width={d * 0.6} height={d * 0.6} draggable={false}
                  style={{ mixBlendMode: "multiply", pointerEvents: "none" }}
                />
              </button>
            );
          })}
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
            <IconTab
              key={t} id={t} variant="dock" size={24}
              badge={t === "chat" ? unread : 0} onClick={() => openTab(t)}
            />
          ))}
        </div>
      )}

      {/* ---------- first-time hint for players ---------- */}
      {hint && !open && !actionToken && (
        <div
          style={{
            position: "absolute", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 90,
            background: "#222d", color: "#fff", borderRadius: 16, padding: "8px 14px", fontSize: 13,
            maxWidth: "calc(100% - 32px)", textAlign: "center", pointerEvents: "none",
          }}
        >
          {mine ? "Double-tap your token to open chat, dice and your stats" : "Tap ☰ to open chat and dice. Your GM will give you a token."}
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
                    <div style={{ display: "flex", alignItems: "stretch", gap: 2, padding: "8px 8px 0", borderBottom: "1px solid #ddd" }}>
            {tabs.map((t) => (
              <IconTab
                key={t} id={t} variant="tab" size={22} stretch active={tab === t}
                badge={t === "chat" ? unread : 0} onClick={() => openTab(t)}
              />
            ))}
            <button
              onClick={() => setOpen(false)}
              title={isGm ? "Minimize" : "Close"}
              style={{ flex: "none", width: 36, border: "none", background: "transparent", cursor: "pointer", fontSize: 16 }}
            >
              {isGm ? "–" : "✕"}
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
            <div style={show("chat")}>
                          <ChatPanel
                mode="chat" large={!narrow} me={me} members={members} messages={messages}
                dice3d={dice3d} onDice3d={setDice3d} onClear={isGm ? clearChat : undefined}
              />    
            </div>
            

                        {/* Initiative tracker */}
            <div style={show("initiative")}>
              <div style={{ ...row, justifyContent: "space-between" }}>
                <b>Initiative{initiative.active ? ` (d${initiative.die})` : ""}</b>
                <span style={{ fontSize: 12, color: initiative.active ? "#1a7f37" : "#777" }}>
                  {initiative.active ? "Running" : "Not started"}
                </span>
              </div>

              {isGm && (
                <div style={{ ...row, marginTop: 8 }}>
                  <button onClick={startInitiative}>
                    {initiative.active ? "Restart initiative" : "Start initiative"}
                  </button>
                  <button onClick={endInitiative} disabled={!initiative.active}>End initiative</button>
                </div>
              )}

              {!initiative.active && (
                <div style={{ fontSize: 12, color: "#777", marginTop: 8 }}>
                  {isGm
                    ? "Start initiative to list every token on this map and ask the players to roll. Choose the dice in Settings."
                    : "The GM has not started initiative."}
                </div>
              )}

              {initiative.active && initRows.length === 0 && (
                <div style={{ fontSize: 13, color: "#777", marginTop: 8 }}>No tokens in the list.</div>
              )}

              {initiative.active &&
                initRows.map((e) => {
                  const t = tokens[e.tokenId];
                  const mineRow = t.ownerId === me.id;
                  return (
                    <div
                      key={e.tokenId}
                      style={{
                        ...row, flexWrap: "nowrap", borderTop: "1px solid #eee", marginTop: 6, paddingTop: 6,
                        background: mineRow ? "#fff9e0" : undefined,
                      }}
                    >
                      <span
                        style={{
                          width: 26, height: 26, flex: "none", border: "1px solid #bbb",
                          borderRadius: t.image ? 4 : "50%",
                          background: t.image ? `url(${t.image}) center / contain no-repeat` : t.color,
                        }}
                      />
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t.label}
                        {t.hidden ? " (hidden)" : ""}
                      </span>
                      {isGm ? (
                        <>
                          <input
                            key={`${e.tokenId}iv${e.value}`} type="number" placeholder="-"
                            defaultValue={e.value ?? ""} style={{ width: 56 }}
                            onBlur={(ev) => setInitValue(e.tokenId, ev.target.value, e.value)}
                          />
                          <button
                            onClick={() => socket.emit("initiativeRoll", { tokenId: e.tokenId })}
                            title={`Roll a d${initiative.die}`}
                          >
                            Roll
                          </button>
                          <button
                            onClick={() => socket.emit("initiativeRemove", { tokenId: e.tokenId })}
                            title="Remove from initiative"
                          >
                            ✕
                          </button>
                        </>
                      ) : e.value !== null ? (
                        <b style={{ minWidth: 32, textAlign: "right" }}>{e.value}</b>
                      ) : mineRow ? (
                        <button onClick={() => socket.emit("initiativeRoll", { tokenId: e.tokenId })}>
                          Roll d{initiative.die}
                        </button>
                      ) : (
                        <span style={{ color: "#999" }}>-</span>
                      )}
                    </div>
                  );
                })}

              {isGm && initiative.active && notInList.length > 0 && (
                <div style={{ ...row, marginTop: 14 }}>
                  <select value={initAddId} onChange={(e) => setInitAddId(e.target.value)}>
                    <option value="">Add a token...</option>
                    {notInList.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                        {t.hidden ? " (hidden)" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={!initAddId}
                    onClick={() => {
                      socket.emit("initiativeAdd", { tokenId: initAddId });
                      setInitAddId("");
                    }}
                  >
                    Add
                  </button>
                </div>
              )}
            </div>

                        {/* Settings */}
            <div style={show("settings")}>
              {isGm ? (
                <div>
                  <div style={{ fontWeight: 600 }}>Initiative dice</div>
                  <div style={{ fontSize: 12, color: "#777", marginTop: 2 }}>
                    The dice rolled for initiative, by the players and by the GM.
                  </div>
                  <div style={{ ...row, marginTop: 6, gap: 14 }}>
                    {[6, 10, 20].map((d) => (
                      <label key={d} style={{ fontSize: 14 }}>
                        <input
                          type="radio" name="initiative-die" checked={initiative.die === d}
                          onChange={() => socket.emit("setInitiativeDie", d)}
                        />{" "}
                        D{d}
                      </label>
                    ))}
                  </div>

                  <div style={{ fontWeight: 600, marginTop: 20 }}>Measurement</div>
                  <div style={{ fontSize: 12, color: "#777", marginTop: 2 }}>
                    Used by the rulers (Line, Circle, Ranges). Each range is the outer limit in feet, measured from
                    the edge of the token. They must grow from Melee to Far.
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 80px", gap: "6px 10px", marginTop: 8, alignItems: "center" }}>
                    {(
                      [
                        ["ftPerSquare", "Feet per square"],
                        ["melee", "Melee (ft)"],
                        ["veryClose", "Very close (ft)"],
                        ["close", "Close (ft)"],
                        ["far", "Far (ft)"],
                      ] as const
                    ).map(([k, label]) => (
                      <label key={k} style={{ display: "contents", fontSize: 14 }}>
                        <span>{label}</span>
                        <input
                          type="number" min={1} value={mVal(k)}
                          onChange={(e) => setMeasureDraft((d) => ({ ...d, [k]: e.target.value }))}
                        />
                      </label>
                    ))}
                  </div>
                  <div style={{ ...row, marginTop: 10 }}>
                    <button onClick={saveMeasure}>Save</button>
                    {measureNote && (
                      <span style={{ fontSize: 13, color: measureNote === "Saved" ? "#1a7f37" : "#c0392b" }}>
                        {measureNote}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ color: "#777", fontSize: 13 }}>Nothing here yet.</div>
              )}
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
                          background: t.image ? `url(${t.image}) center / contain no-repeat` : t.color,
                          transform: t.image ? `rotate(${t.rot ?? 0}deg) scaleX(${t.flip ? -1 : 1})` : undefined,
                        }}
                      />
                      <div style={{ flex: 1 }}>
                        <b>{t.label}</b>
                        <div style={{ fontSize: 12, color: "#777" }}>Size {t.size}x{t.size}</div>
                      </div>
                      <FindButton onClick={() => centerOn(t)} />
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
                    {lookControls(t)}
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
                  </div>
                  <div style={{ ...row, marginTop: 6 }}>
                    <label style={{ fontSize: 13 }}>
                      <input type="checkbox" checked={newHidden} onChange={(e) => setNewHidden(e.target.checked)} />{" "}
                      Hidden from players
                    </label>
                    <label style={{ fontSize: 13 }}>
                      <input type="checkbox" checked={newSave} onChange={(e) => setNewSave(e.target.checked)} />{" "}
                      Save to library
                    </label>
                    <button onClick={addToken}>Add</button>
                  </div>
                  <div style={{ fontSize: 12, color: "#777", marginTop: 6 }}>
                    The token appears in the middle of what you see. Then use "Add image" on its card.
                  </div>
                </details>

                {status}
                {Object.values(tokens).length === 0 && <div style={{ color: "#777" }}>No tokens yet.</div>}
                                {Object.values(tokens).map((t) => {
                  const sel = t.id === selectedId;

                  // Compact row: only HP and Find
                  if (!sel) {
                    return (
                      <div
                        key={t.id}
                        id={`tok-${t.id}`}
                        onClick={() => setSelectedId(t.id)}
                        title="Click to edit this token"
                        style={{ ...cardStyle(t.id), padding: 8, cursor: "pointer", opacity: t.hidden ? 0.7 : 1 }}
                      >
                        <div style={row}>
                          <span
                            style={{
                              width: 22, height: 22, borderRadius: "50%", flex: "none", border: "1px solid #bbb",
                              background: t.image ? `url(${t.image}) center / contain no-repeat` : t.color,
                            }}
                          />
                          <b
                            style={{
                              flex: 1, minWidth: 60, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            }}
                          >
                            {t.label}
                            {t.hidden ? " (hidden)" : ""}
                          </b>
                          <span style={{ ...row, flexWrap: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                            HP
                            <input
                              key={`${t.id}hp${t.hp}`} type="number" defaultValue={t.hp} style={{ width: 45 }}
                              onBlur={(e) => {
                                const v = Number(e.target.value);
                                if (!Number.isNaN(v) && v !== t.hp) update(t.id, { hp: v });
                              }}
                            />
                            /
                            <input
                              key={`${t.id}max${t.maxHp}`} type="number" defaultValue={t.maxHp} style={{ width: 45 }}
                              onBlur={(e) => {
                                const v = Number(e.target.value);
                                if (!Number.isNaN(v) && v !== t.maxHp) update(t.id, { maxHp: v });
                              }}
                            />
                            <FindButton onClick={() => centerOn(t)} />
                          </span>
                        </div>
                        {hpBar(t)}
                      </div>
                    );
                  }

                  // Selected token: the full editor
                  return (
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
                        <FindButton onClick={() => centerOn(t)} />
                        <button
                          onClick={() => {
                            setSelectedId(null);
                            setAction(null);
                          }}
                          title="Close the editor"
                        >
                          Done
                        </button>
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
                        <label style={{ fontSize: 13 }}>
                          <input
                            type="checkbox" checked={!!t.hidden}
                            onChange={(e) => update(t.id, { hidden: e.target.checked })}
                          />{" "}
                          Hidden from players
                        </label>
                      </div>
                      <div style={{ ...row, marginTop: 6 }}>
                        <span style={{ fontSize: 13 }}>Layer</span>
                        <button onClick={() => socket.emit("reorder", { id: t.id, op: "back" })}>Back</button>
                        <button onClick={() => socket.emit("reorder", { id: t.id, op: "down" })} title="One step down">▼</button>
                        <button onClick={() => socket.emit("reorder", { id: t.id, op: "up" })} title="One step up">▲</button>
                        <button onClick={() => socket.emit("reorder", { id: t.id, op: "front" })}>Front</button>
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
                      {lookControls(t)}
                                            <div style={{ ...row, marginTop: 10 }}>
                        {library.some((s) => s.fromTokenId === t.id) ? (
                          <span style={{ fontSize: 12, color: "#1a7f37" }} title="Name, picture, size and max HP stay in step">
                            ✓ In the library
                          </span>
                        ) : (
                          <button onClick={() => saveToLibrary(t)} title="Keep a copy to reuse on any map">
                            Save to library
                          </button>
                        )}
                        <button onClick={() => socket.emit("removeToken", t.id)} style={{ color: "#c0392b" }}>
                          Delete token
                        </button>
                      </div>
                      {libNote && <div style={{ fontSize: 12, color: "#1a5fb4", marginTop: 4 }}>{libNote}</div>}
                    </div>
                  );
                })} 
              </div>
            )}

            {/* GM: library of maps and saved tokens */}
            {isGm && (
              <div style={show("library")}>
                <div style={{ fontWeight: 600 }}>Maps {tier ? `${tier.mapCount} / ${tier.maxMaps}` : ""}</div>
                {tier && (
                  <div style={{ fontSize: 12, color: "#777" }}>
                    {TIER_NAMES[tier.tier]} tier · pictures use {fmtMb(tier.usedBytes)} of {tier.storageMb} MB
                  </div>
                )}
                {libNote && <div style={{ fontSize: 13, color: "#1a5fb4", marginTop: 4 }}>{libNote}</div>}
                {status}
                <div style={{ ...row, marginTop: 8, flexWrap: "nowrap" }}>
                  <input
                    placeholder="New map name" value={newMapName} maxLength={40} style={{ flex: 1, minWidth: 0 }}
                    onChange={(e) => setNewMapName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !mapsFull && createMap()}
                  />
                  <button onClick={createMap} disabled={mapsFull}>Add map</button>
                </div>
                {tier && mapsFull && (
                  <div style={{ fontSize: 12, color: "#c0392b", marginTop: 4 }}>
                    Map limit reached for the {TIER_NAMES[tier.tier]} tier. Delete a map or ask for a higher tier.
                  </div>
                )}

                {maps.map((m) => {
                  const active = m.id === activeMapId;
                  const pic = m.thumb ?? m.image;
                  return (
                    <div
                      key={m.id}
                      style={{
                        display: "flex", gap: 8, border: active ? "2px solid #f1c40f" : "1px solid #ddd",
                        borderRadius: 8, padding: 8, marginTop: 8,
                      }}
                    >
                      <div
                        onClick={() => openMap(m)}
                        title={active ? "This map is in play" : "Click to open this map"}
                        style={{
                          width: 96, height: 72, flex: "none", borderRadius: 6, overflow: "hidden",
                          background: "#e8e0cc", border: "1px solid #ccc", cursor: active ? "default" : "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#777",
                        }}
                      >
                        {pic ? (
                          <img
                            src={pic} alt="" loading="lazy" draggable={false}
                            style={{ width: "100%", height: "100%", objectFit: "contain" }}
                          />
                        ) : (
                          "No picture"
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <input
                          key={m.id + m.name}
                          defaultValue={m.name}
                          maxLength={40}
                          style={{ width: "100%", boxSizing: "border-box" }}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== m.name) socket.emit("renameMap", { id: m.id, name: v });
                          }}
                        />
                        <div style={{ ...row, marginTop: 4 }}>
                          {active ? (
                            <b style={{ fontSize: 12, color: "#8a6d00" }}>In play</b>
                          ) : (
                            <button onClick={() => openMap(m)}>Open</button>
                          )}
                          <button
                            disabled={active}
                            onClick={() => deleteMap(m)}
                            title={active ? "Open another map first" : "Delete this map"}
                            style={{ color: active ? undefined : "#c0392b" }}
                          >
                            Delete
                          </button>
                        </div>
                        <div style={{ fontSize: 11, color: "#777", marginTop: 2 }}>
                          {Math.round(m.w / CELL)} × {Math.round(m.h / CELL)} squares
                        </div>
                                                <details style={{ marginTop: 6 }}>
                          <summary style={{ cursor: "pointer", fontSize: 13 }}>Settings</summary>
                          <div style={{ ...row, marginTop: 6 }}>
                            <button
                              disabled={!!busy}
                              onClick={() => {
                                mapUploadId.current = m.id;
                                mapFileRef.current?.click();
                              }}
                            >
                              {m.image ? "Replace picture" : "Upload picture"}
                            </button>
                            {m.image && <button onClick={() => socket.emit("clearMap", m.id)}>Remove picture</button>}
                          </div>
                          <div style={{ ...row, marginTop: 6 }}>
                            <label style={{ fontSize: 13 }}>
                              Squares across{" "}
                              <input
                                type="number" min={10} max={100} style={{ width: 60 }}
                                value={squaresDraft[m.id] ?? String(Math.round(m.w / CELL))}
                                onChange={(e) => setSquaresDraft((d) => ({ ...d, [m.id]: e.target.value }))}
                              />
                            </label>
                            <button onClick={() => applySquares(m)}>Apply</button>
                            <span style={{ fontSize: 12, color: "#777" }}>{m.w} × {m.h} px</span>
                          </div>
                          <div style={{ fontSize: 11, color: "#777", marginTop: 6 }}>
                            If the picture's own grid does not line up with the game grid, change "Squares across"
                            and press Apply. PNG, JPG or WebP. Large images are resized for you.
                          </div>
                        </details>
                      </div>
                    </div>
                  );
                })}

                <div style={{ marginTop: 18, fontWeight: 600 }}>Saved tokens ({library.length})</div>
                <div style={{ fontSize: 12, color: "#777", marginBottom: 4 }}>
                  Select a token in the Tokens tab and press "Save to library". Saved tokens stay here even after you
                  delete them from a map. "Add to map" puts a fresh copy in the middle of your view.
                </div>
                {library.length === 0 && <div style={{ color: "#777", fontSize: 13 }}>No saved tokens yet.</div>}
                {library.map((s) => (
                  <div
                    key={s.id}
                    style={{ ...row, flexWrap: "nowrap", borderTop: "1px solid #eee", marginTop: 6, paddingTop: 6 }}
                  >
                    <span
                      style={{
                        width: 26, height: 26, borderRadius: "50%", flex: "none", border: "1px solid #bbb",
                        background: s.image ? `url(${s.image}) center / contain no-repeat` : s.color,
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</div>
                      <div style={{ fontSize: 11, color: "#777" }}>{s.size}x{s.size} · HP {s.maxHp}</div>
                    </div>
                    <button onClick={() => addFromLibrary(s)}>Add to map</button>
                    <button onClick={() => socket.emit("libraryDelete", s.id)} style={{ color: "#c0392b" }}>
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* GM: invite links and players */}
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

                {[...invites].reverse().map((i) => {
                  const usable = i.expiresAt > Date.now() && i.uses < i.maxUses;
                  const state = usable ? "Active" : i.uses >= i.maxUses ? "Full" : "Expired";
                  const joined = i.usedBy ?? [];
                  return (
                    <div key={i.code} style={{ marginTop: 10, opacity: usable ? 1 : 0.7 }}>
                      <div style={row}>
                        <input readOnly value={inviteLink(i.code)} style={{ flex: 1, minWidth: 120 }} />
                        {usable && (
                          <button onClick={() => navigator.clipboard.writeText(inviteLink(i.code))}>Copy</button>
                        )}
                        <button onClick={() => socket.emit("revokeInvite", i.code)}>{usable ? "Revoke" : "Remove"}</button>
                      </div>
                      <div style={{ fontSize: 11, color: "#777" }}>
                        {state} · used {i.uses}/{i.maxUses} · expires {new Date(i.expiresAt).toLocaleString()}
                      </div>
                      {joined.length > 0 && (
                        <div style={{ fontSize: 12, marginTop: 2 }}>
                          Joined:{" "}
                          {joined.map((u, idx) => {
                            const gone = !members.some((m) => m.id === u.id);
                            return (
                              <span key={u.id} title={new Date(u.ts).toLocaleString()}>
                                {idx > 0 ? ", " : ""}
                                <span style={gone ? { textDecoration: "line-through", color: "#999" } : undefined}>
                                  {u.name}
                                  {gone ? " (removed)" : ""}
                                </span>
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div style={{ marginTop: 18, fontWeight: 600 }}>Players ({players.length})</div>
                {players.length === 0 && <div style={{ color: "#777", fontSize: 13 }}>Nobody has joined yet.</div>}
                {players.map((p) => {
                  const own = Object.values(tokens).filter((t) => t.ownerId === p.id).length;
                  return (
                    <div key={p.id} style={{ ...row, borderTop: "1px solid #eee", marginTop: 6, paddingTop: 6 }}>
                      <span style={{ flex: 1 }}>{p.name}</span>
                      <span style={{ fontSize: 12, color: "#777" }}>{own} token{own === 1 ? "" : "s"}</span>
                      <button onClick={() => removePlayer(p.id, p.name)}>Remove</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {pwOpen && <ChangePassword onClose={() => setPwOpen(false)} />}
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