import { useState } from "react";
import type { CSSProperties } from "react";
import { socket, updateSession } from "./socket";

const field: CSSProperties = { display: "block", width: "100%", boxSizing: "border-box", margin: "6px 0", padding: 6 };

export default function ChangePassword({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = () => {
    if (next !== again) return setMsg("The new passwords do not match");
    setBusy(true);
    setMsg("");
    socket.emit("changePassword", { current, next }, (res: { ok?: boolean; error?: string; session?: string }) => {
      setBusy(false);
      if (res.ok && res.session) {
        updateSession(res.session);
        setDone(true);
      } else {
        setMsg(res.error ?? "Could not change the password");
      }
    });
  };

  return (
    <div
      style={{
        position: "absolute", inset: 0, zIndex: 200, background: "#0006",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
      }}
    >
      <div style={{ background: "#fff", borderRadius: 10, padding: 20, width: 340, maxWidth: "100%" }}>
        <h3 style={{ marginTop: 0 }}>Change password</h3>
        {done ? (
          <p>Your password was changed. Other devices were signed out.</p>
        ) : (
          <>
            <input style={field} type="password" placeholder="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            <input style={field} type="password" placeholder="New password (8+ characters)" value={next} onChange={(e) => setNext(e.target.value)} />
            <input
              style={field} type="password" placeholder="New password again" value={again}
              onChange={(e) => setAgain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            {msg && <p style={{ color: "#c0392b", fontSize: 14 }}>{msg}</p>}
          </>
        )}
        {!done && <button disabled={busy} onClick={submit}>Save</button>} <button onClick={onClose}>{done ? "Close" : "Cancel"}</button>
      </div>
    </div>
  );
}