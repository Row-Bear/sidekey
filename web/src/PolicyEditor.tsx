import { useEffect, useState } from "react";
import type { ConstraintInput, ExpiryInput, FunctionInfo, PolicyOp, RuleView } from "@poc/core";
import { describeRule, expiryText, shortAddress, type SignersResponse } from "./api";
import { ArgInput } from "./ArgInput";
import type { SigningVia } from "./api-types";
import { SignWith } from "./SignWith";

const LEDGERS_PER_MINUTE = 12;
const OTHER = "other";

type ExpiryKind = "none" | "minutes" | "hours" | "days" | "ledger";

const MINUTES_PER: Record<"minutes" | "hours" | "days", number> = { minutes: 1, hours: 60, days: 1440 };
/** The account's stored policy lives about this long after the last policy change (see the contract's TTL). */
const STORAGE_LIFETIME_MINUTES = 30 * 1440;

function toExpiry(kind: ExpiryKind, value: string): ExpiryInput | null {
  if (kind === "none") return { kind: "none" };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return kind === "ledger" ? { kind: "ledger", ledger: Math.floor(n) } : { kind: "minutes", minutes: n * MINUTES_PER[kind] };
}

export function PolicyEditor({ demo = true, data, busy, contract, functions, loading, nameOf, onApply }: {
  /** The guided demo can sign with the keys it holds; the plain page always signs in the browser. */
  demo?: boolean;
  data: SignersResponse | null;
  busy: boolean;
  /** The contract chosen in the shared picker, and its functions. */
  contract: string;
  functions: FunctionInfo[];
  loading: boolean;
  nameOf: (id: string) => string;
  onApply: (op: PolicyOp, via?: SigningVia) => void;
}) {
  const candidates = data?.signers.filter((s) => s.label !== "master") ?? [];
  const [choice, setChoice] = useState("");
  // Whether the user picked "another signer" themselves, as opposed to it being the fallback while there was none to pick.
  const [pickedOther, setPickedOther] = useState(false);
  const [otherAddress, setOtherAddress] = useState("");
  const [fnName, setFnName] = useState("");
  const [constraints, setConstraints] = useState<ConstraintInput[]>([]);
  const [expiryKind, setExpiryKind] = useState<ExpiryKind>("minutes");
  const [expiryValue, setExpiryValue] = useState("30");
  const [via, setVia] = useState<SigningVia | "demo">(demo ? "demo" : "browser");
  const apply = (op: PolicyOp) => onApply(op, via === "browser" ? "browser" : undefined);

  useEffect(() => {
    if (data && (choice === "" || (choice === OTHER && !pickedOther && candidates.length > 0))) setChoice(candidates[0]?.id ?? OTHER);
  }, [data, choice, pickedOther, candidates]);
  useEffect(() => {
    if (!functions.some((f) => f.name === fnName)) setFnName(functions[0]?.name ?? "");
  }, [functions, fnName]);

  const fn = functions.find((f) => f.name === fnName) ?? null;
  // Address arguments default to "this account", the safe choice for a delegate; others to "any".
  useEffect(() => {
    setConstraints((fn?.args ?? []).map((a): ConstraintInput => ({ kind: a.kind === "address" ? "self" : "any" })));
  }, [fn?.name, contract]);

  const signerRef = choice === OTHER ? otherAddress.trim() : choice;
  const selected = data?.signers.find((s) => s.id === choice) ?? null;
  const expiry = toExpiry(expiryKind, expiryValue);
  const latest = data?.latestLedger ?? 0;
  const valueMissing = constraints.some((c) => (c.kind === "exact" || c.kind === "lessThan") && !(c.value ?? "").trim());
  const limitInvalid = constraints.some((c) => c.kind === "lessThan" && (c.value ?? "").trim() !== "" && !/^-?\d+$/.test((c.value ?? "").trim()));
  const canAllow = !busy && signerRef !== "" && fn !== null && expiry !== null && !valueMissing && !limitInvalid;
  const registered = selected?.registered ?? false;

  const setConstraint = (i: number, patch: Partial<ConstraintInput>) =>
    setConstraints((current) => current.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <section className="card">
      <h2>Policy editor</h2>
      <p className="muted small">
        The master decides what a delegate may call. Each rule gives a constraint per argument; anything not allowed is
        refused.
      </p>

      <label className="field">
        <span className="field-label">Signer</span>
        <select
          value={choice}
          onChange={(e) => {
            setChoice(e.target.value);
            setPickedOther(e.target.value === OTHER);
          }}
          disabled={!data}
        >
          {candidates.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label} {shortAddress(s.address)}{s.registered ? "" : " (not registered yet)"}
            </option>
          ))}
          <option value={OTHER}>Another signer (G address)…</option>
        </select>
        {choice === OTHER && (
          <input value={otherAddress} onChange={(e) => setOtherAddress(e.target.value)} placeholder="G…" spellCheck={false} />
        )}
      </label>

      {selected?.registered && selected.policy && (
        <div className="current">
          <div className="muted small">
            Current rules
            {selected.policy.validUntilLedger === null
              ? " (no expiry)"
              : latest > selected.policy.validUntilLedger
                ? " (expired)"
                : ` (${expiryText(selected.policy.validUntilLedger, latest)})`}
          </div>
          {selected.policy.rules.length === 0 && <div className="muted">None</div>}
          <ul>
            {selected.policy.rules.map((rule: RuleView) => (
              <li key={`${rule.contract}.${rule.function}.${rule.args.map((a) => a.kind).join()}`}>
                <code>{describeRule(rule)}</code> <span className="muted small">on {nameOf(rule.contract)}</span>
                <button
                  className="ghost small-btn"
                  disabled={busy}
                  onClick={() => apply({ op: "remove-rule", signer: signerRef, contract: rule.contract, function: rule.function })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3>Allow a call</h3>
      <div className="muted small contract-line">Contract: <strong>{nameOf(contract.trim())}</strong> (chosen above)</div>
      <label className="field">
        <span className="field-label">Function {loading && <span className="muted">(loading…)</span>}</span>
        <select value={fnName} onChange={(e) => setFnName(e.target.value)} disabled={functions.length === 0}>
          {functions.map((f) => <option key={f.name} value={f.name}>{f.name}({f.args.map((a) => a.name).join(", ")})</option>)}
        </select>
      </label>

      {fn?.args.map((arg, i) => {
        const constraint = constraints[i] ?? { kind: "any" as const };
        return (
          <div key={`${contract}.${fn.name}.${arg.name}`} className="constraint">
            <span className="field-label">{arg.name} <span className="muted">{arg.type}</span></span>
            <select value={constraint.kind} onChange={(e) => setConstraint(i, { kind: e.target.value as ConstraintInput["kind"] })}>
              <option value="any">any value</option>
              {arg.kind === "address" && <option value="self">this account</option>}
              {arg.kind === "integer" && (
                <option value="lessThan" disabled={data?.features.lessThan === false}>
                  less than…{data?.features.lessThan === false ? " (needs a newer smart account)" : ""}
                </option>
              )}
              <option value="exact">exactly…</option>
            </select>
            {constraint.kind === "exact" && (
              <ArgInput
                arg={{ ...arg, name: "value" }}
                value={constraint.value ?? ""}
                onChange={(value) => setConstraint(i, { value })}
                account={data?.smartAccount ?? ""}
              />
            )}
            {constraint.kind === "lessThan" && (
              <>
                <ArgInput
                  arg={{ ...arg, name: "limit" }}
                  value={constraint.value ?? ""}
                  onChange={(value) => setConstraint(i, { value })}
                  account={data?.smartAccount ?? ""}
                />
                <span className="muted hint">
                  The value must be strictly below this limit (it sets no lower bound). Only smart accounts created after this
                  option existed can enforce it.
                </span>
                {(constraint.value ?? "").trim() !== "" && !/^-?\d+$/.test((constraint.value ?? "").trim()) && (
                  <span className="error small">The limit must be a whole number</span>
                )}
              </>
            )}
          </div>
        );
      })}

      <div className="field">
        <span className="field-label">Expiry <span className="muted">(applied when the signer is first registered)</span></span>
        <span className="field-row">
          <select value={expiryKind} onChange={(e) => setExpiryKind(e.target.value as ExpiryKind)}>
            <option value="none">No expiry</option>
            <option value="minutes">In N minutes</option>
            <option value="hours">In N hours</option>
            <option value="days">In N days</option>
            <option value="ledger">At ledger</option>
          </select>
          {expiryKind !== "none" && (
            <input
              className="short"
              type="number"
              min={1}
              value={expiryValue}
              onChange={(e) => setExpiryValue(e.target.value)}
            />
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
            That is beyond about 30 days. The account's stored policy lasts about 30 days after the last policy change, so
            the signer may stop working before this expiry unless the policy is changed again.
          </span>
        )}
        {expiry === null && <span className="error small">Enter a number greater than zero</span>}
      </div>

      {fn && selected?.policy?.rules.some((r) => r.contract === contract.trim() && r.function === fn.name) && (
        <span className="warn small">
          This signer already has a rule for {fn.name}() on this contract. A new rule is added next to it, and a call is
          allowed if any rule matches, so remove the old rule above to replace it.
        </span>
      )}

      {demo && <SignWith value={via} onChange={setVia} disabled={busy} />}

      <div className="actions">
        <button
          disabled={!canAllow}
          onClick={() =>
            fn && expiry && apply({ op: "allow", signer: signerRef, contract: contract.trim(), function: fn.name, constraints, expiry })
          }
        >
          {busy ? "Working…" : registered ? "Allow this call" : "Register signer and allow this call"}
        </button>
        <button
          className="ghost"
          disabled={busy || !registered || expiry === null}
          onClick={() => expiry && apply({ op: "set-expiry", signer: signerRef, expiry })}
          title="Change the expiry of a registered signer"
        >
          Set expiry
        </button>
        <button className="ghost danger" disabled={busy || !registered} onClick={() => apply({ op: "revoke", signer: signerRef })}>
          Revoke signer
        </button>
      </div>
      <span className="muted small">Policy edits are signed by the master and paid for by the fee sponsor.</span>
    </section>
  );
}
