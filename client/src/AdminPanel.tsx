import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { signOut, socket } from "./socket";
import type { AdminInit, GmRow } from "./types";

const th: CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "8px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap" };

const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fmtDate = (t: number) => (t ? new Date(t).toLocaleString() : "never");

export default function AdminPanel({ init }: { init: AdminInit }) {
  const [rows, setRows] = useState<GmRow[]>(init.gms);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "paid" | "unpaid">("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const upsert = (r: GmRow) =>
      setRows((all) => (all.some((x) => x.id === r.id) ? all.map((x) => (x.id === r.id ? r : x)) : [r, ...all]));
    socket.on("adminGm", upsert);
    socket.on("adminGms", setRows);
    return () => {
      socket.off("adminGm", upsert);
      socket.off("adminGms", setRows);
    };
  }, []);

  const setPaid = (r: GmRow, paid: boolean) => {
    if (
      !paid && r.online > 0 &&
      !window.confirm(`${r.username} has ${r.online} user(s) online. Marking unpaid disconnects them right away. Continue?`)
    ) {
      return;
    }
    setBusy(r.id);
    setError("");
    socket.emit("adminSetPaid", { id: r.id, paid }, (res: { ok?: boolean; error?: string }) => {
      setBusy(null);
      if (!res?.ok) setError(res?.error ?? "Could not change the status");
    });
  };

  // Unpaid first (they need your attention), newest first inside each group
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows
      .filter((r) => (filter === "all" ? true : filter === "paid" ? r.paid : !r.paid))
      .filter((r) => !term || r.username.toLowerCase().includes(term) || r.campaign.toLowerCase().includes(term))
      .sort((a, b) => Number(a.paid) - Number(b.paid) || b.createdAt - a.createdAt);
  }, [rows, q, filter]);

  const paidCount = rows.filter((r) => r.paid).length;

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 1100, margin: "0 auto", padding: 20 }}>
      <h2 style={{ marginTop: 0 }}>
        Superadmin{" "}
        <span style={{ fontSize: 13, fontWeight: "normal", color: "#555" }}>
          {init.me.name} <button onClick={signOut}>Sign out</button>
        </span>
      </h2>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
        <span><b>{rows.length}</b> GMs</span>
        <span style={{ color: "#1a7f37" }}><b>{paidCount}</b> paid</span>
        <span style={{ color: "#c0392b" }}><b>{rows.length - paidCount}</b> not paid</span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input placeholder="Search username or table" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All</option>
          <option value="paid">Paid</option>
          <option value="unpaid">Not paid</option>
        </select>
        <button onClick={() => socket.emit("adminList")}>Refresh</button>
      </div>
      {error && <div style={{ color: "#c0392b", marginBottom: 8 }}>{error}</div>}

      <div style={{ overflowX: "auto", border: "1px solid #ddd", borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={th}>Username</th>
              <th style={th}>Table</th>
              <th style={th}>Players</th>
              <th style={th}>Online</th>
              <th style={th}>Storage</th>
              <th style={th}>Created</th>
              <th style={th}>Last sign-in</th>
              <th style={th}>Status</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td style={td} colSpan={9}>No GM accounts found.</td>
              </tr>
            )}
            {shown.map((r) => (
              <tr key={r.id}>
                <td style={td}><b>{r.username}</b></td>
                <td style={td}>{r.campaign}</td>
                <td style={td}>{r.players}</td>
                <td style={td}>{r.online}</td>
                <td style={td}>{fmtBytes(r.storage)}</td>
                <td style={td}>{fmtDate(r.createdAt)}</td>
                <td style={td}>{fmtDate(r.lastLoginAt)}</td>
                <td style={{ ...td, color: r.paid ? "#1a7f37" : "#c0392b", fontWeight: 600 }}>
                  {r.paid ? "Paid" : "Not paid"}
                </td>
                <td style={td}>
                  <button disabled={busy === r.id} onClick={() => setPaid(r, !r.paid)}>
                    {r.paid ? "Mark unpaid" : "Mark paid"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}