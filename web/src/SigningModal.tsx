import { useEffect, useState } from "react";
import type { PendingSignature } from "@poc/core";
import { cancelSignature, shortAddress, submitSignature } from "./api";
import type { BrowserSigner } from "./signing";
import { walletError } from "./wallet";

type Kind = "payload" | "message";

function secondsLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
}

function CopyBox({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="field">
      <span className="field-label">
        {label}{" "}
        <button
          type="button"
          className="ghost small-btn"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
      <code className="copybox">{value}</code>
    </div>
  );
}

/** Shown whenever the server is waiting for a signature that only the browser can produce. */
export function SigningModal({ request, signers, onDone }: { request: PendingSignature; signers: BrowserSigner[]; onDone: () => void }) {
  const [kind, setKind] = useState<Kind>("payload");
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // A new request starts with a clean form.
  useEffect(() => {
    setSignature("");
    setError(null);
  }, [request.id]);

  const left = secondsLeft(request.expiresAt, now);
  const automatic = signers.filter((s) => s.appliesTo(request));

  const run = async (action: () => Promise<void>) => {
    setWorking(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (err) {
      setError(walletError(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="signing-title">
      <div className="modal">
        <h2 id="signing-title">Signature needed</h2>
        <p className="muted small">
          {request.kind === "transaction" ? "Sign the transaction as " : "Sign as "}<span className={`badge ${request.signer.label === "master" ? "master" : "delegate"}`}>{request.signer.label}</span>{" "}
          <code title={request.signer.address}>{shortAddress(request.signer.address)}</code>. Expires in {left}s.
        </p>

        <div className="field">
          <span className="field-label">This will authorize</span>
          <ul className="summary">
            {request.summary.map((line) => <li key={line}><code>{line}</code></li>)}
            {request.summary.length === 0 && <li className="muted">Nothing on the smart account's behalf</li>}
          </ul>
        </div>

        {automatic.length > 0 && (
          <div className="actions">
            {automatic.map((signer) => (
              <button key={signer.id} disabled={working} onClick={() => void run(async () => submitSignature(request.id, await signer.sign(request)))}>
                {signer.label}
              </button>
            ))}
          </div>
        )}

        <details open={automatic.length === 0}>
          <summary>Sign manually</summary>
          <p className="muted small">
            Produce an ed25519 signature with the key above (a wallet, or <code>stellar</code> tooling), then paste it here
            (base64 or hex).
          </p>
          {request.kind === "transaction" ? (
            <>
              <CopyBox label="Transaction (unsigned XDR)" value={request.transactionXdr} />
              <p className="muted small">
                Transaction hash <code>{request.transactionHashHex.slice(0, 16)}…</code>. Sign it with the account above (for
                example in Stellar Lab) and paste the signed XDR below. The wallet pays its fee.
              </p>
            </>
          ) : (
            <>
              <div className="tabs">
                <button type="button" className={kind === "payload" ? "tab active" : "tab"} onClick={() => setKind("payload")}>
                  Sign the payload
                </button>
                <button type="button" className={kind === "message" ? "tab active" : "tab"} onClick={() => setKind("message")}>
                  Sign a SEP-53 message
                </button>
              </div>
              {kind === "payload" ? (
                <>
                  <CopyBox label="Payload (32-byte hash, hex)" value={request.payloadHex} />
                  <p className="muted small">What a wallet's signAuthEntry signs: sign these 32 bytes directly.</p>
                </>
              ) : (
                <>
                  <CopyBox label="Message" value={request.message} />
                  <p className="muted small">For wallets with signMessage: it signs sha256("Stellar Signed Message:\n" + message).</p>
                </>
              )}
            </>
          )}
          <label className="field">
            <span className="field-label">{request.kind === "transaction" ? "Signed transaction XDR" : "Signature"}</span>
            <textarea value={signature} onChange={(e) => setSignature(e.target.value)} rows={2} spellCheck={false} placeholder={request.kind === "transaction" ? "signed envelope, base64 XDR" : "base64 or hex"} />
          </label>
          <div className="actions">
            <button disabled={working || signature.trim() === ""} onClick={() => void run(() => submitSignature(request.id, request.kind === "transaction" ? { kind: "transaction", signedXdr: signature.trim() } : { kind, signature }))}>
              {working ? "Checking…" : "Submit signature"}
            </button>
          </div>
        </details>

        {error && <p className="error small">{error}</p>}

        <div className="actions modal-foot">
          <button className="ghost danger" disabled={working} onClick={() => void run(() => cancelSignature(request.id, "Cancelled in the dashboard"))}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
