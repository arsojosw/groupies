import { useEffect, useState } from "react";
import AuthScreen from "./AuthScreen";
import Game from "./Game";
import { socket } from "./socket";
import type { Init } from "./types";

const joinCode = new URLSearchParams(window.location.search).get("join");

export default function App() {
  const [init, setInit] = useState<Init | null>(null);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<"connecting" | "unauth" | "ready">("connecting");

  useEffect(() => {
    const onInit = (data: Init) => {
      setInit(data);
      setVersion((v) => v + 1);
      setStatus("ready");
      if (joinCode) window.history.replaceState(null, "", "/");
    };
    const onUnauth = () => {
      setInit(null);
      setStatus("unauth");
    };
    socket.on("init", onInit);
    socket.on("unauth", onUnauth);
    if (socket.connected) socket.emit("hello");
    return () => {
      socket.off("init", onInit);
      socket.off("unauth", onUnauth);
    };
  }, []);

  if (status === "connecting") return <div style={{ padding: 40, fontFamily: "sans-serif" }}>Connecting...</div>;
  if (status === "unauth" || !init) return <AuthScreen joinCode={joinCode} />;
  return <Game key={version} init={init} />;
}