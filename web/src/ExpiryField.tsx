import { type ExpiryKind, LEDGERS_PER_MINUTE, STORAGE_LIFETIME_MINUTES, toExpiry } from "./expiry";

/** An expiry chooser: none, in N minutes, hours or days, or at a ledger, with the date it works out to. */
export function ExpiryField({ kind, value, onKind, onValue, latest, label }: {
  kind: ExpiryKind;
  value: string;
  onKind: (kind: ExpiryKind) => void;
  onValue: (value: string) => void;
  /** The latest ledger, to say which ledger a relative expiry works out to. */
  latest: number;
  label?: string;
}) {
  const expiry = toExpiry(kind, value);
  return (
    <div className="field">
      {label && <span className="field-label">{label}</span>}
      <span className="field-row">
        <select value={kind} onChange={(e) => onKind(e.target.value as ExpiryKind)} aria-label="Expiry">
          <option value="none">No expiry</option>
          <option value="minutes">In N minutes</option>
          <option value="hours">In N hours</option>
          <option value="days">In N days</option>
          <option value="ledger">At ledger</option>
        </select>
        {kind !== "none" && (
          <input className="short" type="number" min={1} value={value} onChange={(e) => onValue(e.target.value)} aria-label="Expiry amount" />
        )}
      </span>
      {expiry?.kind === "minutes" && (
        <span className="muted hint">
          About ledger {(latest + Math.round(expiry.minutes * LEDGERS_PER_MINUTE)).toLocaleString("en-US")}, around{" "}
          {new Date(Date.now() + expiry.minutes * 60_000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </span>
      )}
      {expiry?.kind === "minutes" && expiry.minutes > STORAGE_LIFETIME_MINUTES && (
        <span className="warn small">
          That is beyond about 30 days. The account's stored policy lasts about 30 days after the last policy change, so the
          signer may stop working before this expiry unless the policy is changed again.
        </span>
      )}
      {expiry === null && <span className="error small">Enter a number greater than zero</span>}
    </div>
  );
}
