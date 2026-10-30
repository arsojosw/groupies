import { useState } from "react";
import { socket } from "./socket";
import { panel, row } from "./styles";
import type { Me, Member, Msg, Roll } from "./types";

type Props = {
  me: Me; members: Member[]; messages: Msg[];
  dice3d: boolean; onDice3d: (v: boolean) => void;
};

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

export default function ChatPanel({ me, members, messages, dice3d, onDice3d }: Props) {
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
  const roll = () => socket.emit("roll", { formula, to: toList() });

  const tag = (m: Msg) => {
    if (m.to === null) return "";
    if (m.fromId === me.id) {
      return m.to.length === 1 && m.to[0] === me.id ? "secret, only you" : `whisper to ${m.to.map(nameOf).join(", ")}`;
    }
    return "whispered to you";
  };

  const newestFirst = [...messages].reverse();

  return (
    <div style={panel}>
      <b>Chat</b>

      <div style={{ ...row, marginTop: 8 }}>
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
        <span style={{ fontSize: 12, color: "#777" }}>applies to messages and rolls</span>
      </div>
      <div style={{ ...row, marginTop: 6 }}>
        <input
          value={text} placeholder="Message" maxLength={500} style={{ flex: 1 }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button onClick={send}>Send</button>
      </div>
      <div style={{ ...row, marginTop: 6 }}>
        <input
          value={formula} style={{ flex: 1 }}
          onChange={(e) => setFormula(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && roll()}
        />
        <button onClick={roll}>Roll</button>
      </div>
      <div style={{ ...row, marginTop: 6 }}>
        <button onClick={() => setFormula("2d20kh1")}>Adv</button>
        <button onClick={() => setFormula("2d20kl1")}>Dis</button>
        <span style={{ fontSize: 11, color: "#777" }}>kh = keep highest, kl = keep lowest, e.g. 4d6kh3, 2d20kh1+5</span>
      </div>
      <label style={{ display: "block", marginTop: 6, fontSize: 13 }}>
        <input type="checkbox" checked={dice3d} onChange={(e) => onDice3d(e.target.checked)} /> 3D dice
      </label>

      <div
        style={{ height: 240, overflowY: "auto", border: "1px solid #eee", borderRadius: 6, padding: 6, marginTop: 8, fontSize: 14 }}
      >
        {newestFirst.length === 0 && <div style={{ color: "#777" }}>No messages yet.</div>}
        {newestFirst.map((m) => (
          <div
            key={m.id}
            style={{ marginBottom: 6, padding: m.to ? "3px 6px" : 0, background: m.to ? "#f3ecff" : "transparent", borderRadius: 4 }}
          >
            <span style={{ fontSize: 11, color: "#777" }}>
              {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
            </span>
            <b>{m.fromName}</b>
            {tag(m) && <span style={{ fontSize: 11, color: "#7b3fb5" }}> ({tag(m)})</span>}
            {": "}
            {m.kind === "roll" && m.roll ? <RollText r={m.roll} /> : m.text}
          </div>
        ))}
      </div>
    </div>
  );
}