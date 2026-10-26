import { useState } from "react";
import type { CallRecord } from "@poc/core";
import { friendlyError, shortenAddresses } from "./api";

function status(record: CallRecord): { label: string; className: string } {
  if (record.outcome === "success") return { label: "Succeeded", className: "succeeded" };
  if (record.cancelled) return { label: "Cancelled", className: "cancelled" };
  return record.rejectedByPolicy
    ? { label: "Rejected by policy ✓", className: "blocked" }
    : { label: "Failed", className: "unexpected" };
}

const RECENT = 5;
const ICON: Record<string, string> = { succeeded: "✓", cancelled: "⊘", blocked: "!", unexpected: "✗" };

/** One line per call or policy edit, with the latest few shown and the rest a click away. */
function CompactHistory({ calls }: { calls: CallRecord[] }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? calls : calls.slice(0, RECENT);
  return (
    <section className="card">
      <h2>Recent activity</h2>
      {calls.length === 0 ? (
        <p className="muted small">Nothing yet. Calls sent from the builder and policy edits appear here.</p>
      ) : (
        <>
          <ul className="activity">
            {shown.map((record) => {
              const s = status(record);
              return (
                <li key={record.id} className={`activity-row ${s.className}`}>
                  <span className="activity-icon" role="img" aria-label={s.label} title={s.label}>
                    {ICON[s.className]}
                  </span>
                  <div className="activity-main">
                    <div className="activity-line">
                      <code title={record.title}>{shortenAddresses(record.title)}</code>
                      <span className={`badge ${record.signer === "master" ? "master" : "delegate"}`}>{record.signer}</span>
                      <span className="muted small">{new Date(record.at).toLocaleTimeString("en-GB")}</span>
                      {record.explorerUrl && (
                        <a className="small" href={record.explorerUrl} target="_blank" rel="noreferrer" title={record.txHash}>
                          View tx
                        </a>
                      )}
                    </div>
                    {record.cancelled ? (
                      <div className="activity-detail muted small">Cancelled before it was signed</div>
                    ) : (
                      record.error && (
                        <div className={`activity-detail small ${record.rejectedByPolicy ? "warn" : "bad"}`}>
                          {record.rejectedByPolicy ? "Refused by the policy: " : ""}
                          {friendlyError(record.error).summary}
                        </div>
                      )
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {calls.length > RECENT && (
            <button type="button" className="ghost small-btn" onClick={() => setShowAll((all) => !all)}>
              {showAll ? "Show fewer" : `Show ${calls.length - RECENT} more`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

export function CallHistory({ calls, compact = false }: { calls: CallRecord[]; compact?: boolean }) {
  if (compact) return <CompactHistory calls={calls} />;
  return (
    <section className="card">
      <h2>Custom calls and policy edits</h2>
      {calls.length === 0 ? (
        <p className="muted small">Nothing yet. Calls sent from the builder and policy edits appear here.</p>
      ) : (
        <ul className="history">
          {calls.map((record) => {
            const s = status(record);
            return (
              <li key={record.id} className={`step ${s.className}`}>
                <div className="step-head">
                  <div className="step-title">
                    <strong><code>{record.title}</code></strong>
                    <span className="muted small">
                      <span className={`badge ${record.signer === "master" ? "master" : "delegate"}`}>{record.signer}</span>
                      {record.kind === "policy" ? "policy edit" : "call"} · {new Date(record.at).toLocaleTimeString("en-GB")}
                    </span>
                  </div>
                  <span className={`status ${s.className}`}>{s.label}</span>
                </div>
                <div className="step-body flush">
                  {record.explorerUrl && (
                    <a href={record.explorerUrl} target="_blank" rel="noreferrer">
                      View transaction {record.txHash?.slice(0, 10)}…
                    </a>
                  )}
                  {record.error && (
                    <div className={record.rejectedByPolicy ? "rejection" : "error"}>
                      {record.rejectedByPolicy ? "Blocked before submission: " : ""}
                      {record.error}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
