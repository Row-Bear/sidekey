import { useEffect } from "react";
import type { CallRecord } from "@poc/core";
import { friendlyError, shortenAddresses } from "./api";

type Kind = "success" | "cancelled" | "blocked" | "failure";

const kindOf = (record: CallRecord): Kind =>
  record.cancelled ? "cancelled" : record.outcome === "success" ? "success" : record.rejectedByPolicy ? "blocked" : "failure";

const HEADLINE: Record<Kind, string> = {
  success: "Done",
  cancelled: "Cancelled",
  blocked: "Refused by the policy",
  failure: "Failed",
};

/**
 * The result of the last call or policy edit, shown where the user is looking. Successes and cancellations go away
 * by themselves; refusals and failures stay until dismissed, because they need reading.
 */
export function Toast({ record, onDismiss }: { record: CallRecord; onDismiss: () => void }) {
  const kind = kindOf(record);
  useEffect(() => {
    if (kind !== "success" && kind !== "cancelled") return;
    const timer = setTimeout(onDismiss, 9000);
    return () => clearTimeout(timer);
  }, [record.id, kind, onDismiss]);

  return (
    <div className={`toast ${kind}`} role="status" aria-live="polite">
      <div className="toast-body">
        <strong>{HEADLINE[kind]}</strong>
        <code className="toast-title" title={record.title}>{shortenAddresses(record.title)}</code>
        {record.explorerUrl && (
          <a href={record.explorerUrl} target="_blank" rel="noreferrer">
            View transaction {record.txHash?.slice(0, 10)}…
          </a>
        )}
        {record.error && kind !== "cancelled" && <span className="small">{friendlyError(record.error).summary}</span>}
      </div>
      <button type="button" className="ghost small-btn" aria-label="Dismiss" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}
