import type { CallRecord } from "@poc/core";

function status(record: CallRecord): { label: string; className: string } {
  if (record.outcome === "success") return { label: "Succeeded", className: "succeeded" };
  return record.rejectedByPolicy
    ? { label: "Rejected by policy ✓", className: "blocked" }
    : { label: "Failed", className: "unexpected" };
}

export function CallHistory({ calls }: { calls: CallRecord[] }) {
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
