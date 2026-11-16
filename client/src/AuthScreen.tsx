import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { getSession, reconnectWith, socket } from "./socket";

type TablePlayer = { id: string; name: string; online: boolean };
type Res = {
  ok?: boolean; error?: string; session?: string; needName?: boolean;
  campaign?: string; canCreate?: boolean; players?: TablePlayer[];
};

const box: CSSProperties = {
  maxWidth: 360, margin: "60px auto", fontFamily: "sans-serif", padding: 20,
  border: "1px solid #ccc", borderRadius: 8,
};
const field: CSSProperties = { display: "block", width: "100%", boxSizing: "border-box", margin: "6px 0", padding: 6 };
const red: CSSProperties = { color: "#c0392b", fontSize: 14 };
const choice: CSSProperties = {
  display: "block", width: "100%", boxSizing: "border-box", textAlign: "left",
  padding: "8px 10px", marginBottom: 6, cursor: "pointer",
};

export default function AuthScreen({ joinCode }: { joinCode: string | null }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [joinState, setJoinState] = useState<"checking" | "form" | "failed">("checking");
  const [tableName, setTableName] = useState("");
  const [players, setPlayers] = useState<TablePlayer[]>([]);
  const [canCreate, setCanCreate] = useState(true);

  // Invite link: resume if this browser already belongs to the table, otherwise show who can be picked
  useEffect(() => {
    if (!joinCode) return;
    socket.emit("join", { code: joinCode, session: getSession() }, (res: Res) => {
      if (res.ok && res.session) {
        window.history.replaceState(null, "", "/");
        reconnectWith(res.session);
      } else if (res.needName) {
        setTableName(res.campaign ?? "");
        setPlayers(res.players ?? []);
        setCanCreate(res.canCreate !== false);
        setJoinState("form");
      } else {
        setError(res.error ?? "Invalid invite link");
        setJoinState("failed");
      }
    });
  }, [joinCode]);

  const finish = (res: Res) => {
    setBusy(false);
    if (res.ok && res.session) {
      if (joinCode) window.history.replaceState(null, "", "/");
      reconnectWith(res.session);
    } else {
      setError(res.error ?? "Something went wrong");
    }
  };

  const submitJoin = () => {
    if (!name.trim()) return setError("Enter a display name");
    setBusy(true);
    setError("");
    socket.emit("join", { code: joinCode, name }, finish);
  };

  // Come back as a player who already joined this table
  const submitExisting = (playerId: string) => {
    setBusy(true);
    setError("");
    socket.emit("join", { code: joinCode, playerId }, finish);
  };

  const submitGm = () => {
    setBusy(true);
    setError("");
    if (mode === "login") socket.emit("login", { username, password }, finish);
    else socket.emit("register", { username, password, campaignName }, finish);
  };

  if (joinCode) {
    return (
      <div style={box}>
        <h2 style={{ marginTop: 0 }}>Join table</h2>
        {joinState === "checking" && <p>Checking invite link...</p>}
        {joinState === "failed" && <p style={red}>{error}</p>}
        {joinState === "form" && (
          <>
            <p style={{ marginTop: 0 }}>
              You are invited to <b>{tableName}</b>.
            </p>

            {players.length > 0 && (
              <>
                <div style={{ fontWeight: 600 }}>Already joined before? Pick your name:</div>
                <div style={{ marginTop: 6 }}>
                  {players.map((pl) => (
                    <button key={pl.id} disabled={busy} onClick={() => submitExisting(pl.id)} style={choice}>
                      {pl.name}
                      {pl.online ? " (online now)" : ""}
                    </button>
                  ))}
                </div>
              </>
            )}

            {canCreate ? (
              <>
                <div style={{ fontWeight: 600, marginTop: players.length > 0 ? 14 : 0 }}>
                  {players.length > 0 ? "New here? Choose a display name:" : "Choose a display name:"}
                </div>
                <input
                  style={field} placeholder="Display name" maxLength={20} value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitJoin()}
                />
                <button disabled={busy} onClick={submitJoin}>Join</button>
              </>
            ) : (
              <p style={{ fontSize: 13, color: "#777", marginTop: 12 }}>
                This link has no free places for new players.
                {players.length === 0 ? " Ask your GM for a new link." : " Pick your name above if you were here before."}
              </p>
            )}
            {error && <p style={red}>{error}</p>}
          </>
        )}
        <p style={{ fontSize: 12, color: "#777" }}>
          Game Masters: <a href="/">sign in here</a>
        </p>
      </div>
    );
  }

  return (
    <div style={box}>
      <h2 style={{ marginTop: 0 }}>{mode === "login" ? "GM sign in" : "Create GM account"}</h2>
      <input style={field} placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <input
        style={field} type="password" placeholder="Password (8+ characters)" value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submitGm()}
      />
      {mode === "register" && (
        <input
          style={field} placeholder="Table name (optional)" maxLength={40} value={campaignName}
          onChange={(e) => setCampaignName(e.target.value)}
        />
      )}
      <button disabled={busy} onClick={submitGm}>{mode === "login" ? "Sign in" : "Create account"}</button>
      {error && <p style={red}>{error}</p>}
      {mode === "register" && (
        <p style={{ fontSize: 12, color: "#777" }}>
          New accounts are activated by the administrator after payment is confirmed.
        </p>
      )}
      <p style={{ fontSize: 13 }}>
        {mode === "login" ? "New GM? " : "Already have an account? "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setError("");
            setMode(mode === "login" ? "register" : "login");
          }}
        >
          {mode === "login" ? "Create an account" : "Sign in"}
        </a>
      </p>
      <p style={{ fontSize: 12, color: "#777" }}>Players: open the invite link your GM sent you.</p>
    </div>
  );
}