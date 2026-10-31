import { io } from "socket.io-client";

const KEY = "vtt:session";

export function getSession(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

function storeSession(s: string) {
  try {
    if (s) localStorage.setItem(KEY, s);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export const socket = io({ auth: { session: getSession() } });

// Reconnect so the server sees the new login
export function reconnectWith(session: string) {
  storeSession(session);
  socket.auth = { session };
  socket.disconnect().connect();
}

export function signOut() {
  const finish = () => socket.emit("logout", () => reconnectWith(""));
  if (socket.connected) finish();
  else {
    socket.once("connect", finish);
    socket.connect();
  }
}