import { useState } from "react";
import type { CSSProperties } from "react";
import { socket } from "./socket";
import { row } from "./styles";
import type { Me, Member, Msg, Roll } from "./types";

type Props = {
  me: Me; members: Member[]; messages: Msg[];
  mode: "chat" | "dice"; // "chat": messages and log. "dice": only the dice pad (rolls are logged in the chat)
  dice3d: boolean; onDice3d: (v: boolean) => void;
  large?: boolean; // laptop screens: taller log and bigger fields
  onRoll?: () => void; // called after a roll is sent (phones use it to clear the screen)
  onClear?: () => void; // GM only: shows a "Clear chat" button
};

const DICE = [2, 4, 6, 8, 10, 12, 20, 100];

// Dropped dice (keep highest / keep lowest) are shown crossed out
function RollText({ r }: { r: Roll }) {
  const dice = r.rolls.map((v, i) => (
    <span key={i} style={r.keep && !r.keep[i] ? { textDecoration: "line-through", color: "#999" } : undefined}>
      {v}
      {i < r.rolls.length - 1 ? ", " : ""}
    </span>
  ));
  return (
    <>
      rolled {r.formula}: [{dice}] = <b>{r.total}</b>
    </>
  );
}

export default function ChatPanel({ me, members, messages, mode, dice3d, onDice3d, large, onRoll, onClear }: Props) {
  const [target, setTarget] = useState("all");
  const [text, setText] = useState("");
  const [formula, setFormula] = useState("1d20+3");

  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? "?";
  const toList = (): string[] | null => (target === "all" ? null : target === "self" ? [me.id] : [target]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    socket.emit("chat", { text: t, to: toList() });
    setText("");
  };

  const roll = () => {
    socket.emit("roll", { formula, to: toList() });
    onRoll?.();
  };

  // Dice button: the same dice again adds one more die (1d4, 2d4, 3d4...); a different dice starts over
  const addDie = (sides: number) => {
    const m = formula.trim().match(/^(\d+)d(\d+)$/i);
    const count = m && Number(m[2]) === sides ? Math.min(Number(m[1]) + 1, 100) : 1;
    setFormula(`${count}d${sides}`);
  };

  const tag = (m: Msg) => {
    if (m.to === null) return "";
    if (m.fromId === me.id) {
      return m.to.length === 1 && m.to[0] === me.id ? "secret, only you" : `whisper to ${m.to.map(nameOf).join(", ")}`;
    }
    return "whispered to you";
  };

  // Newest first
  const shown = [...messages].reverse();

  // Bigger fields and a taller log on laptop screens
  const field: CSSProperties = large ? { fontSize: 16, padding: "10px 12px" } : {};
  const button: CSSProperties = large ? { fontSize: 15, padding: "10px 18px" } : {};
  const dieButton: CSSProperties = large
    ? { fontSize: 14, padding: "8px 10px", minWidth: 50 }
    : { padding: "6px 8px", minWidth: 40 };
  const logHeight = large ? "calc(100vh - 205px)" : "min(45vh, 320px)";

  return (
    <div>
      <div style={row}>
        <span style={{ fontSize: 13 }}>To</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="all">Everyone</option>
          {me.role === "gm" && <option value="self">Only me (secret)</option>}
          {members.filter((m) => m.id !== me.id).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}{m.role === "gm" ? " (GM)" : ""}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: "#777" }}>
          applies to {mode === "chat" ? "messages" : "rolls"}
        </span>
        {mode === "chat" && onClear && (
          <button onClick={onClear} style={{ marginLeft: "auto" }} title="Delete all messages for everyone">
            Clear chat
          </button>
        )}
      </div>

      {mode === "chat" ? (
        <div style={{ ...row, marginTop: 6, flexWrap: "nowrap" }}>
          <input
            value={text} placeholder="Message" maxLength={500} style={{ flex: 1, minWidth: 0, ...field }}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
          />
          <button style={button} onClick={send}>Send</button>
        </div>
      ) : (
        <>
          <div style={{ ...row, marginTop: 6, flexWrap: "nowrap" }}>
            <input
              value={formula} style={{ flex: 1, minWidth: 0, ...field }}
              onChange={(e) => setFormula(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && roll()}
            />
            <button style={button} onClick={roll}>Roll</button>
          </div>
          <div style={{ ...row, marginTop: 6, gap: 4 }}>
            {DICE.map((s) => (
              <button key={s} style={dieButton} onClick={() => addDie(s)} title={`Add a d${s}`}>
                D{s}
              </button>
            ))}
          </div>
          <div style={{ ...row, marginTop: 6 }}>
            <button onClick={() => setFormula("2d20kh1")}>Adv</button>
            <button onClick={() => setFormula("2d20kl1")}>Dis</button>
            <span style={{ fontSize: 11, color: "#777" }}>
              kh = keep highest, kl = keep lowest, e.g. 4d6kh3, 2d20kh1+5
            </span>
          </div>
          <label style={{ display: "block", marginTop: 6, fontSize: 13 }}>
            <input type="checkbox" checked={dice3d} onChange={(e) => onDice3d(e.target.checked)} /> 3D dice
          </label>
        </>
      )}

      {/* The message log is only in the chat. Rolls show up there too. */}
      {mode === "chat" && (
        <div
          style={{
            height: logHeight, minHeight: large ? 200 : undefined, overflowY: "auto",
            border: "1px solid #eee", borderRadius: 6, padding: 6, marginTop: 8, fontSize: large ? 15 : 14,
          }}
        >
          {shown.length === 0 && <div style={{ color: "#777" }}>No messages yet.</div>}
          {shown.map((m) => (
            <div
              key={m.id}
              style={{ marginBottom: 6, padding: m.to ? "3px 6px" : 0, background: m.to ? "#f3ecff" : "transparent", borderRadius: 4 }}
            >
              <span style={{ fontSize: 11, color: "#777" }}>
                {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
              </span>
              {m.kind === "action" ? (
                <>
                  <i>{m.text}</i>
                  {tag(m) && <span style={{ fontSize: 11, color: "#7b3fb5" }}> ({tag(m)})</span>}
                </>
              ) : (
                <>
                  <b>{m.fromName}</b>
                  {tag(m) && <span style={{ fontSize: 11, color: "#7b3fb5" }}> ({tag(m)})</span>}
                  {": "}
                  {m.kind === "roll" && m.roll ? <RollText r={m.roll} /> : m.text}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}