import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { signOut, socket } from "./socket";
import type { AdminInit, GmRow, LogEntry } from "./types";

const th: CSSProperties = { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid #ddd", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "8px 10px", borderBottom: "1px solid #eee", whiteSpace: "nowrap", verticalAlign: "top" };
const tab = (on: boolean): CSSProperties => ({
  border: "none", cursor: "pointer", padding: "8px 14px", borderRadius: "6px 6px 0 0",
  background: on ? "#222" : "#eee", color: on ? "#fff" : "#222",
});

const DAY = 86_400_000;
const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fmtDate = (t: number) => (t ? new Date(t).toLocaleString() : "never");
const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const ACTIONS: Record<string, string> = {
  "gm.registered": "Signed up",
  "gm.paid": "Marked paid",
  "gm.unpaid": "Marked unpaid",
  "gm.expired": "Paid period ended (automatic)",
  "gm.password_reset": "Password reset by admin",
  "gm.password_changed": "Changed own password",
  "gm.deleted": "Account deleted",
  "admin.login": "Admin signed in",
  "login.lockout": "Sign-in locked (too many failures)",
  "player.removed": "GM removed a player",
};

type Res = { ok?: boolean; error?: string; password?: string };

function statusOf(r: GmRow) {
  if (r.paid) return { label: "Paid", color: "#1a7f37" };
  if (r.paidUntil !== null && r.paidUntil < Date.now()) return { label: "Expired", color: "#c0392b" };
  return { label: "Not paid", color: "#c0392b" };
}

function untilText(r: GmRow) {
  if (r.paid && r.paidUntil === null) return "No end date";
  if (r.paidUntil === null) return "-";
  if (!r.paid) return fmtDay(r.paidUntil);
  const days = Math.ceil((r.paidUntil - Date.now()) / DAY);
  return `${fmtDay(r.paidUntil)} (${days} day${days === 1 ? "" : "s"} left)`;
}

const expiringSoon = (r: GmRow) => r.paid && r.paidUntil !== null && r.paidUntil - Date.now() <= 7 * DAY;

export default function AdminPanel({ init }: { init: AdminInit }) {
  const [view, setView] = useState<"gms" | "log">("gms");
  const [rows, setRows] = useState<GmRow[]>(init.gms);
  const [log, setLog] = useState<LogEntry[]>(init.log);
  const [q, setQ] = useState("");
  const [logQ, setLogQ] = useState("");
  const [filter, setFilter] = useState<"all" | "paid" | "unpaid" | "soon">("all");
  const [months, setMonths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [tempPw, setTempPw] = useState<{ user: string; pw: string } | null>(null);

  useEffect(() => {
    const upsert = (r: GmRow) =>
      setRows((all) => (all.some((x) => x.id === r.id) ? all.map((x) => (x.id === r.id ? r : x)) : [r, ...all]));
    const removed = (id: string) => setRows((all) => all.filter((x) => x.id !== id));
    const onLog = (e: LogEntry) => setLog((all) => [...all, e].slice(-500));
    socket.on("adminGm", upsert);
    socket.on("adminGms", setRows);
    socket.on("adminGmRemoved", removed);
    socket.on("adminLog", onLog);
    socket.on("adminLogs", setLog);
    return () => {
      socket.off("adminGm", upsert);
      socket.off("adminGms", setRows);
      socket.off("adminGmRemoved", removed);
      socket.off("adminLog", onLog);
      socket.off("adminLogs", setLog);
    };
  }, []);

  const run = (id: string, event: string, payload: object, onOk?: (res: Res) => void) => {
    setBusy(id);
    setError("");
    socket.emit(event, payload, (res: Res) => {
      setBusy(null);
      if (!res?.ok) setError(res?.error ?? "Something went wrong");
      else onOk?.(res);
    });
  };

  const setPaid = (r: GmRow, paid: boolean) => {
    if (
      !paid && r.online > 0 &&
      !window.confirm(`${r.username} has ${r.online} user(s) online. Marking unpaid disconnects them right away. Continue?`)
    ) {
      return;
    }
    const sel = months[r.id] ?? "1";
    run(r.id, "adminSetPaid", { id: r.id, paid, months: sel === "none" ? null : Number(sel) });
  };

  const resetPassword = (r: GmRow) => {
    if (!window.confirm(`Reset the password of ${r.username}? They will be signed out everywhere.`)) return;
    run(r.id, "adminResetPassword", { id: r.id }, (res) => setTempPw({ user: r.username, pw: res.password ?? "" }));
  };

  const remove = (r: GmRow) => {
    const typed = window.prompt(
      `Delete ${r.username}, their table "${r.campaign}", ${r.players} player account(s) and ${fmtBytes(r.storage)} of images?\n` +
        `This cannot be undone.\n\nType the username to confirm:`
    );
    if (typed === null) return;
    run(r.id, "adminDeleteGm", { id: r.id, confirm: typed });
  };

  // Accounts that need attention first, newest first inside each group
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows
      .filter((r) =>
        filter === "all" ? true : filter === "paid" ? r.paid : filter === "unpaid" ? !r.paid : expiringSoon(r)
      )
      .filter((r) => !term || r.username.toLowerCase().includes(term) || r.campaign.toLowerCase().includes(term))
      .sort((a, b) => Number(a.paid) - Number(b.paid) || b.createdAt - a.createdAt);
  }, [rows, q, filter]);

  const shownLog = useMemo(() => {
    const term = logQ.trim().toLowerCase();
    return [...log]
      .reverse()
      .filter(
        (e) =>
          !term ||
          `${e.actor} ${e.target ?? ""} ${e.detail ?? ""} ${ACTIONS[e.action] ?? e.action}`.toLowerCase().includes(term)
      );
  }, [log, logQ]);

  const paidCount = rows.filter((r) => r.paid).length;
  const soonCount = rows.filter(expiringSoon).length;

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 1200, margin: "0 auto", padding: 20 }}>
      <h2 style={{ marginTop: 0 }}>
        Superadmin{" "}
        <span style={{ fontSize: 13, fontWeight: "normal", color: "#555" }}>
          {init.me.name} <button onClick={signOut}>Sign out</button>
        </span>
      </h2>

      <div style={{ display: "flex", gap: 6, borderBottom: "2px solid #222", marginBottom: 12 }}>
        <button style={tab(view === "gms")} onClick={() => setView("gms")}>GM accounts</button>
        <button style={tab(view === "log")} onClick={() => setView("log")}>Activity log</button>
      </div>

      {error && <div style={{ color: "#c0392b", marginBottom: 8 }}>{error}</div>}

      {tempPw && (
        <div style={{ border: "2px solid #f1c40f", background: "#fff9e0", padding: 12, borderRadius: 8, marginBottom: 12 }}>
          <b>Temporary password for {tempPw.user}:</b> <code style={{ fontSize: 16 }}>{tempPw.pw}</code>{" "}
          <button onClick={() => navigator.clipboard.writeText(tempPw.pw)}>Copy</button>{" "}
          <button onClick={() => setTempPw(null)}>Hide</button>
          <div style={{ fontSize: 12, color: "#555", marginTop: 4 }}>
            Shown only once. Send it to the GM privately. After signing in they can change it from the ☰ menu.
          </div>
        </div>
      )}

      {view === "gms" && (
        <>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
            <span><b>{rows.length}</b> GMs</span>
            <span style={{ color: "#1a7f37" }}><b>{paidCount}</b> paid</span>
            <span style={{ color: "#c0392b" }}><b>{rows.length - paidCount}</b> not paid</span>
            <span style={{ color: "#b9770e" }}><b>{soonCount}</b> ending within 7 days</span>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <input placeholder="Search username or table" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="all">All</option>
              <option value="paid">Paid</option>
              <option value="unpaid">Not paid / expired</option>
              <option value="soon">Ending within 7 days</option>
            </select>
            <button onClick={() => socket.emit("adminList")}>Refresh</button>
          </div>

          <div style={{ overflowX: "auto", border: "1px solid #ddd", borderRadius: 8 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={th}>Username</th>
                  <th style={th}>Table</th>
                  <th style={th}>Players</th>
                  <th style={th}>Online</th>
                  <th style={th}>Storage</th>
                  <th style={th}>Last sign-in</th>
                  <th style={th}>Status</th>
                  <th style={th}>Paid until</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td style={td} colSpan={9}>No GM accounts found.</td>
                  </tr>
                )}
                {shown.map((r) => {
                  const st = statusOf(r);
                  return (
                    <tr key={r.id}>
                      <td style={td}><b>{r.username}</b></td>
                      <td style={td}>{r.campaign}</td>
                      <td style={td}>{r.players}</td>
                      <td style={td}>{r.online}</td>
                      <td style={td}>{fmtBytes(r.storage)}</td>
                      <td style={td}>{fmtDate(r.lastLoginAt)}</td>
                      <td style={{ ...td, color: st.color, fontWeight: 600 }}>{st.label}</td>
                      <td style={{ ...td, color: expiringSoon(r) ? "#b9770e" : undefined }}>{untilText(r)}</td>
                      <td style={{ ...td, whiteSpace: "normal", minWidth: 300 }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <select
                            value={months[r.id] ?? "1"}
                            onChange={(e) => setMonths((m) => ({ ...m, [r.id]: e.target.value }))}
                          >
                            <option value="1">1 month</option>
                            <option value="3">3 months</option>
                            <option value="6">6 months</option>
                            <option value="12">1 year</option>
                            <option value="none">No end date</option>
                          </select>
                          <button
                            disabled={busy === r.id}
                            onClick={() => setPaid(r, true)}
                            title={r.paid ? "Adds the chosen time on top of the current end date" : "Activates the account"}
                          >
                            {r.paid ? "Renew" : "Mark paid"}
                          </button>
                          {r.paid && (
                            <button disabled={busy === r.id} onClick={() => setPaid(r, false)}>Mark unpaid</button>
                          )}
                          <button disabled={busy === r.id} onClick={() => resetPassword(r)}>Reset password</button>
                          <button disabled={busy === r.id} onClick={() => remove(r)} style={{ color: "#c0392b" }}>
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {view === "log" && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <input placeholder="Search the log" value={logQ} onChange={(e) => setLogQ(e.target.value)} />
            <button onClick={() => socket.emit("adminLogList")}>Refresh</button>
            <span style={{ fontSize: 12, color: "#777", alignSelf: "center" }}>
              Newest first. The last 2000 entries are kept.
            </span>
          </div>
          <div style={{ overflowX: "auto", border: "1px solid #ddd", borderRadius: 8 }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={th}>Time</th>
                  <th style={th}>Who</th>
                  <th style={th}>What</th>
                  <th style={th}>GM</th>
                  <th style={th}>Details</th>
                </tr>
              </thead>
              <tbody>
                {shownLog.length === 0 && (
                  <tr>
                    <td style={td} colSpan={5}>Nothing logged yet.</td>
                  </tr>
                )}
                {shownLog.map((e) => (
                  <tr key={e.id}>
                    <td style={td}>{fmtDate(e.ts)}</td>
                    <td style={td}>{e.actor}</td>
                    <td style={td}>{ACTIONS[e.action] ?? e.action}</td>
                    <td style={td}>{e.target ?? ""}</td>
                    <td style={{ ...td, whiteSpace: "normal" }}>{e.detail ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}