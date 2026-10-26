import { useState } from "react";
import type { CallRequest, SignerView } from "@poc/core";
import { shortAddress } from "./api";
import { MAX_CALL_LABEL, MAX_SAVED_CALLS, type SavedCalls } from "./savedCalls";

/** Small cards for the calls saved from the call builder; clicking one sends it right away. */
export function SavedCallCards({ saved, signers, nameOf, busy, walletReady, onRun }: {
  saved: SavedCalls;
  signers: SignerView[];
  nameOf: (id: string) => string;
  busy: boolean;
  walletReady: boolean;
  onRun: (call: CallRequest) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  if (saved.calls.length === 0) return null;

  return (
    <section className="card saved-calls">
      <h2>
        Saved calls <span className="muted small">({saved.calls.length}/{MAX_SAVED_CALLS})</span>
      </h2>
      <div className="saved-grid">
        {saved.calls.map((s, i) => {
          const signer = signers.find((x) => x.id === s.call.signer);
          const blocked = !signer ? "That signer is no longer on this account" : signer.label === "master" && !walletReady ? "Connect your wallet to sign as master" : "";
          const who = signer ? (signer.label === "master" ? "master" : `${signer.label} ${shortAddress(signer.address)}`) : "unknown signer";
          return (
            <div key={`${i}-${s.label}`} className="saved-card">
              {editing === i ? (
                <input
                  autoFocus
                  value={draft}
                  maxLength={MAX_CALL_LABEL}
                  aria-label="Name"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      saved.rename(i, draft);
                      setEditing(null);
                    } else if (e.key === "Escape") setEditing(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="saved-run"
                  disabled={busy || blocked !== ""}
                  title={blocked || `Send ${s.call.function}(${s.call.args.join(", ")}) on ${nameOf(s.call.contract)} as ${who}`}
                  onClick={() => onRun(s.call)}
                >
                  <strong>{s.label}</strong>
                  <span className="muted small">as {who}</span>
                </button>
              )}
              <span className="saved-tools">
                <button type="button" className="icon-btn" title="Rename" aria-label={`Rename ${s.label}`} onClick={() => { setDraft(s.label); setEditing(i); }}>✎</button>
                <button type="button" className="icon-btn" title="Remove" aria-label={`Remove ${s.label}`} onClick={() => saved.remove(i)}>✕</button>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
