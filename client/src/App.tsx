import { useEffect, useState } from "react";
import AdminPanel from "./AdminPanel";
import AuthScreen from "./AuthScreen";
import Game from "./Game";
import LockedScreen from "./LockedScreen";
import { socket } from "./socket";
import type { AdminInit, Init, Locked } from "./types";

const joinCode = new URLSearchParams(window.location.search).get("join");

type Screen =
  | { kind: "connecting" }
  | { kind: "unauth" }
  | { kind: "game"; init: Init; version: number }
  | { kind: "admin"; init: AdminInit }
  | { kind: "locked"; info: Locked };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "connecting" });

  useEffect(() => {
    const onInit = (init: Init) => {
      setScreen((prev) => ({ kind: "game", init, version: prev.kind === "game" ? prev.version + 1 : 1 }));
      if (joinCode) window.history.replaceState(null, "", "/");
    };
    const onAdmin = (init: AdminInit) => setScreen({ kind: "admin", init });
    const onLocked = (info: Locked) => setScreen({ kind: "locked", info });
    const onUnauth = () => setScreen({ kind: "unauth" });
    socket.on("init", onInit);
    socket.on("adminInit", onAdmin);
    socket.on("locked", onLocked);
    socket.on("unauth", onUnauth);
    if (socket.connected) socket.emit("hello");
    return () => {
      socket.off("init", onInit);
      socket.off("adminInit", onAdmin);
      socket.off("locked", onLocked);
      socket.off("unauth", onUnauth);
    };
  }, []);

  switch (screen.kind) {
    case "connecting":
      return <div style={{ padding: 40, fontFamily: "sans-serif" }}>Connecting...</div>;
    case "unauth":
      return <AuthScreen joinCode={joinCode} />;
    case "admin":
      return <AdminPanel init={screen.init} />;
    case "locked":
      return <LockedScreen info={screen.info} />;
    default:
      return <Game key={screen.version} init={screen.init} />;
  }
}