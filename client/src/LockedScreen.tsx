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
          Your GM account is not active yet. After the administrator confirms your payment, you can use the site.
          Press "Check again" once you have been told it is activated.
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