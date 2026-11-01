import type { CSSProperties } from "react";
import { getSession, reconnectWith, signOut } from "./socket";
import type { Locked } from "./types";

const box: CSSProperties = {
  maxWidth: 400, margin: "60px auto", fontFamily: "sans-serif", padding: 20,
  border: "1px solid #ccc", borderRadius: 8,
};

export default function LockedScreen({ info }: { info: Locked }) {
  const isGm = info.role === "gm";
  return (
    <div style={box}>
      <h2 style={{ marginTop: 0 }}>{isGm ? "Account not active" : "Table not active"}</h2>
      {isGm ? (
                <p>
          Your GM account is not active. It is either waiting for activation or its paid period has ended.
          Ask the administrator to activate or renew it, then press "Check again".
        </p>
      ) : (
        <p>
          The table <b>{info.campaign}</b> is not active right now. Please ask your GM, then press "Check again".
        </p>
      )}
      <button onClick={() => reconnectWith(getSession())}>Check again</button>{" "}
      <button onClick={signOut}>Sign out</button>
    </div>
  );
}