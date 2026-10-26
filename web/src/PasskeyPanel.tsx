import { useState } from "react";
import type { DemoState } from "./api-types";
import { registerPasskey, selectDelegate } from "./api";
import { createPasskey, passkeysSupported } from "./passkey";

/** Choose who plays the delegate: the demo's own key, or a passkey created here that never leaves this device. */
export function PasskeyPanel({ demo = true, state, busy, onChanged }: { demo?: boolean; state: DemoState; busy: boolean; onChanged: () => void }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = passkeysSupported();

  const act = async (action: () => Promise<unknown>) => {
    setWorking(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const wrongSite = state.passkey !== null && state.passkey.rpId !== location.hostname;

  return (
    <section className="card wallet-panel">
      <div className="section-head">
        <h2>Delegate signer</h2>
        {demo && (
        <div className="mode-switch" role="group" aria-label="Delegate kind">
          <button className={state.delegate === "key" ? "tab active" : "tab"} disabled={busy || working || state.delegate === "key"} onClick={() => void act(() => selectDelegate("key"))}>
            Demo key
          </button>
          <button
            className={state.delegate === "passkey" ? "tab active" : "tab"}
            disabled={busy || working || state.delegate === "passkey" || !state.passkey}
            title={state.passkey ? undefined : "Create a passkey first"}
            onClick={() => void act(() => selectDelegate("passkey"))}
          >
            Passkey
          </button>
        </div>
        )}
      </div>
      <p className="muted small">
        {!demo && state.passkey === null
          ? "Create a passkey to act as the delegate. Each of its calls then asks for your device (fingerprint, PIN or security key), and the smart account checks the WebAuthn signature itself. You can also register another G address as a signer in the policy editor."
          : state.delegate === "passkey" || !demo
          ? "The delegate is a passkey: each of its calls asks for your device (fingerprint, PIN or security key). The smart account checks the WebAuthn signature itself."
          : "The delegate is a key this demo holds. Create a passkey to make the delegate a device-bound signer instead; it applies to the next smart account."}
      </p>
      {state.passkey && (
        <p className="muted small">
          Passkey <code title={state.passkey.publicKeyHex}>{state.passkey.publicKeyHex.slice(2, 10)}…</code> for <code>{state.passkey.rpId}</code>
          {wrongSite && <span className="error"> (open the dashboard at {state.passkey.rpId} to use it)</span>}
        </p>
      )}
      <div className="actions">
        <button
          className={state.passkey ? "ghost" : undefined}
          disabled={busy || working || !supported}
          title={supported ? undefined : "Passkeys need https or localhost"}
          onClick={() => void act(async () => registerPasskey(await createPasskey()))}
        >
          {working ? "Waiting for your device…" : state.passkey ? "Create a new passkey" : "Create passkey"}
        </button>
      </div>
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
