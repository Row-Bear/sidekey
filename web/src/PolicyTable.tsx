import { useState } from "react";
import type { CallRequest, PolicyOp, RuleView, SignerView } from "@poc/core";
import { describeRule, expiryText, shortAddress, type SignersResponse } from "./api";
import { ExpiryField } from "./ExpiryField";
import { type ExpiryKind, toExpiry } from "./expiry";
import { callFromRule, delegatesFirst, signerStatus } from "./signers";

/**
 * Every signer on the account with where it stands and what it may do, and the actions that change it: remove a
 * rule, set the expiry, revoke. The one place that shows the account's policy.
 */
export function PolicyTable({ data, canEdit, busy, nameOf, onApply, onRun, onFillIn }: {
  data: SignersResponse | null;
  /** Whether the owning wallet is connected; without it the table is read-only. */
  canEdit: boolean;
  busy: boolean;
  nameOf: (id: string) => string;
  onApply: (op: PolicyOp) => void;
  /** Sends the call a rule allows, as that signer. */
  onRun: (call: CallRequest) => void;
  /** Hands a rule's call to the call builder when some argument still has to be chosen. */
  onFillIn: (call: CallRequest) => void;
}) {
  // One row at a time can be in the middle of setting an expiry or confirming a revoke.
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [kind, setKind] = useState<ExpiryKind>("minutes");
  const [value, setValue] = useState("30");

  if (!data) {
    return (
      <section className="card">
        <h2>Signing policy</h2>
        <p className="muted small">Loading…</p>
      </section>
    );
  }

  const latest = data.latestLedger;
  const master = data.signers.find((s) => s.label === "master");
  const delegates = delegatesFirst(data.signers, latest);
  const expiry = toExpiry(kind, value);

  const apply = (op: PolicyOp) => {
    setEditing(null);
    setConfirming(null);
    onApply(op);
  };

  const statusCell = (signer: SignerView) => {
    const status = signerStatus(signer, latest);
    switch (status.kind) {
      case "master":
        return <span className="muted">never expires</span>;
      case "unregistered":
        return <span className="tag">not registered</span>;
      case "no-expiry":
        return <span className="muted">no expiry</span>;
      case "expired":
        return <span className="tag expired">expired</span>;
      case "active":
        return <span className="muted small">{expiryText(status.validUntil, latest)}</span>;
    }
  };

  return (
    <section className="card">
      <h2>Signing policy</h2>
      <table className="policy-table">
        <thead>
          <tr>
            <th>Signer</th>
            <th>Status</th>
            <th>May authorize</th>
          </tr>
        </thead>
        <tbody>
          {master && (
            <tr>
              <td>
                <span className="badge master" title="The master can authorize anything">master</span>{" "}
                <span title={master.address}>{shortAddress(master.address)}</span>
              </td>
              <td>{statusCell(master)}</td>
              <td>Any call</td>
            </tr>
          )}
          {delegates.map((signer) => {
            const policy = signer.registered ? signer.policy : null;
            const status = signerStatus(signer, latest);
            return (
              <tr key={signer.id}>
                <td>
                  <span className={`badge ${signer.label === "delegate" ? "delegate" : "other"}`} title="A delegate can only do what its rules allow">
                    {signer.label}
                  </span>{" "}
                  <span title={signer.kind === "passkey" ? "A passkey on your device" : signer.address}>
                    {signer.kind === "passkey" ? signer.address : shortAddress(signer.address)}
                  </span>
                </td>
                <td>{statusCell(signer)}</td>
                <td>
                  {policy === null ? (
                    <span className="muted">Nothing yet. Add a rule below to register it.</span>
                  ) : policy.rules.length === 0 ? (
                    <span className="muted">No rules, so it can do nothing</span>
                  ) : (
                    <ul className="rules">
                      {policy.rules.map((rule: RuleView) => (
                        <li key={`${rule.contract}.${rule.function}.${rule.args.map((a) => a.kind).join()}`}>
                          <code>{describeRule(rule)}</code> <span className="muted small">on {nameOf(rule.contract)}</span>
                          {status.kind !== "unregistered" && status.kind !== "expired" && signer.viaBrowser && (() => {
                            const rc = callFromRule(rule, data.smartAccount);
                            const request: CallRequest = { contract: rule.contract, function: rc.function, args: rc.args, signer: signer.id };
                            return rc.complete ? (
                              <button type="button" className="small-btn rule-run" disabled={busy} title={`Send ${describeRule(rule)} as this signer`} onClick={() => onRun(request)}>
                                Run
                              </button>
                            ) : (
                              <button type="button" className="ghost small-btn rule-run" title="Some arguments are open: choose them in the call builder" onClick={() => onFillIn(request)}>
                                Fill in…
                              </button>
                            );
                          })()}
                          {canEdit && (
                            <button
                              type="button"
                              className="ghost small-btn"
                              disabled={busy}
                              aria-label={`Remove the rule ${describeRule(rule)} from ${signer.address}`}
                              title="Remove this rule"
                              onClick={() => apply({ op: "remove-rule", signer: signer.id, contract: rule.contract, function: rule.function })}
                            >
                              Remove
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {canEdit && policy !== null && (
                    <div className="row-actions">
                      {editing === signer.id ? (
                        <div className="inline-form">
                          <ExpiryField kind={kind} value={value} onKind={setKind} onValue={setValue} latest={latest} />
                          <div className="actions">
                            <button disabled={busy || expiry === null} onClick={() => expiry && apply({ op: "set-expiry", signer: signer.id, expiry })}>
                              Set expiry
                            </button>
                            <button type="button" className="ghost" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : confirming === signer.id ? (
                        <div className="actions">
                          <span className="small">Revoke this signer completely?</span>
                          <button className="danger" disabled={busy} onClick={() => apply({ op: "revoke", signer: signer.id })}>
                            Yes, revoke
                          </button>
                          <button type="button" className="ghost" onClick={() => setConfirming(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="actions">
                          <button
                            type="button"
                            className="ghost small-btn"
                            disabled={busy}
                            title={status.kind === "expired" ? "It has expired: set a new expiry to use it again" : "Change when this signer stops working"}
                            onClick={() => {
                              setConfirming(null);
                              setEditing(signer.id);
                            }}
                          >
                            Set expiry
                          </button>
                          <button
                            type="button"
                            className="ghost small-btn danger"
                            disabled={busy}
                            title="Remove this signer and all its rules"
                            onClick={() => {
                              setEditing(null);
                              setConfirming(signer.id);
                            }}
                          >
                            Revoke
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          {delegates.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                No delegate yet. Create a passkey above, then give it permission in the editor below.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
