import { useEffect, useState } from "react";
import { STATIC } from "./build";
import type { ConstraintInput, FunctionInfo, PolicyOp, RuleView } from "@poc/core";
import { describeRule, expiryText, shortAddress, type SignersResponse } from "./api";
import { ArgInput } from "./ArgInput";
import type { SigningVia } from "./api-types";
import { ExpiryField } from "./ExpiryField";
import { FunctionPicker } from "./FunctionPicker";
import { defaultFunction, describeSignature, looksReadOnly } from "./functions";
import { type ExpiryKind, toExpiry } from "./expiry";
import { SignWith } from "./SignWith";
import { delegatesFirst } from "./signers";

const OTHER = "other";

export function PolicyEditor({ demo = true, compact = false, data, busy, contract, functions, loading, nameOf, onApply }: {
  /** The guided demo can sign with the keys it holds; the plain page always signs in the browser. */
  demo?: boolean;
  /**
   * The plain page: rules, expiry and revoking are managed in the Signing policy table, so this only adds a rule, and
   * asks for an expiry only when the signer is being registered.
   */
  compact?: boolean;
  data: SignersResponse | null;
  busy: boolean;
  /** The contract chosen in the shared picker, and its functions. */
  contract: string;
  functions: FunctionInfo[];
  loading: boolean;
  nameOf: (id: string) => string;
  onApply: (op: PolicyOp, via?: SigningVia) => void;
}) {
  const candidates = data ? delegatesFirst(data.signers, data.latestLedger) : [];
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
  // A rule for a read-only function does nothing, so those are hidden unless asked for.
  const [showReads, setShowReads] = useState(false);
  const pickable = showReads ? functions : functions.filter((f) => !looksReadOnly(f.name));
  useEffect(() => {
    if (!pickable.some((f) => f.name === fnName)) setFnName(defaultFunction(pickable.length > 0 ? pickable : functions));
  }, [functions, pickable.length, fnName]);

  const fn = functions.find((f) => f.name === fnName) ?? null;
  // The constraints follow the function's whole signature, so a same-named function with other arguments resets them too.
  const fnKey = fn ? describeSignature(fn) : "";
  // Address arguments default to "this account", the safe choice for a delegate; others to "any".
  useEffect(() => {
    setConstraints((fn?.args ?? []).map((a): ConstraintInput => ({ kind: a.kind === "address" ? "self" : "any" })));
  }, [fnKey, contract]);

  const signerRef = choice === OTHER ? otherAddress.trim() : choice;
  const selected = data?.signers.find((s) => s.id === choice) ?? null;
  // Functions the chosen signer already has a rule for on this contract.
  const allowedHere = new Set(selected?.policy?.rules.filter((r) => r.contract === contract.trim()).map((r) => r.function) ?? []);
  const latest = data?.latestLedger ?? 0;
  const registered = selected?.registered ?? false;
  // A registered signer keeps its expiry (the table changes it); a new one needs one.
  const needsExpiry = !compact || !registered;
  const expiry = toExpiry(expiryKind, expiryValue);
  const valueMissing = constraints.some((c) => (c.kind === "exact" || c.kind === "lessThan") && !(c.value ?? "").trim());
  const limitInvalid = constraints.some((c) => c.kind === "lessThan" && (c.value ?? "").trim() !== "" && !/^-?\d+$/.test((c.value ?? "").trim()));
  const canAllow = !busy && signerRef !== "" && fn !== null && (expiry !== null || !needsExpiry) && !valueMissing && !limitInvalid;

  const setConstraint = (i: number, patch: Partial<ConstraintInput>) =>
    setConstraints((current) => current.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  return (
    <section className="card">
      <h2>{compact ? "Add a rule" : "Policy editor"}</h2>
      <p className="muted small">
        {compact
          ? "Allow a delegate to call one function, with a limit on each argument. Anything not allowed is refused."
          : "The master decides what a delegate may call. Each rule gives a constraint per argument; anything not allowed is refused."}
      </p>

      <label className="field">
        <span className="field-label">Give permission to</span>
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

      {!compact && selected?.registered && selected.policy && (
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
                  aria-label={`Remove the rule ${describeRule(rule)}`}
                  title={`Remove the rule ${describeRule(rule)}`}
                  onClick={() => apply({ op: "remove-rule", signer: signerRef, contract: rule.contract, function: rule.function })}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!compact && <h3>Allow a call</h3>}
      <div className="muted small contract-line">Contract: <strong>{nameOf(contract.trim())}</strong> (chosen above)</div>
      <div className="field">
        <span className="field-label">Function {loading && <span className="muted">(loading…)</span>}</span>
        <FunctionPicker
          functions={functions}
          value={fnName}
          onChange={setFnName}
          allowed={allowedHere}
          showReadOnly={showReads}
          onShowReadOnlyChange={setShowReads}
          loading={loading}
        />
        {fn && looksReadOnly(fn.name) && (
          <span className="muted small">This looks read-only: it needs no permission, so a rule for it has no effect.</span>
        )}
      </div>

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

      {needsExpiry && (
        <ExpiryField
          label={compact ? "Expiry for the new signer" : "Expiry (applied when the signer is first registered)"}
          kind={expiryKind}
          value={expiryValue}
          onKind={setExpiryKind}
          onValue={setExpiryValue}
          latest={latest}
        />
      )}

      {fn && selected?.policy?.rules.some((r) => r.contract === contract.trim() && r.function === fn.name) && (
        <span className="warn small">
          This signer already has a rule for {fn.name}() on this contract. A new rule is added next to it, and a call is
          allowed if any rule matches, so remove the old rule {compact ? "in the Signing policy table" : "above"} to replace it.
        </span>
      )}

      {demo && <SignWith value={via} onChange={setVia} disabled={busy} />}

      <div className="actions">
        <button
          disabled={!canAllow}
          onClick={() =>
            fn &&
            apply({
              op: "allow",
              signer: signerRef,
              contract: contract.trim(),
              function: fn.name,
              constraints,
              ...(expiry ? { expiry } : {}),
            })
          }
        >
          {busy ? "Working…" : registered ? (compact ? "Add rule" : "Allow this call") : compact ? "Register signer and add rule" : "Register signer and allow this call"}
        </button>
        {!compact && (
          <>
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
          </>
        )}
      </div>
      <span className="muted small">{STATIC ? "Policy edits are signed by the master; a relayer pays the fee." : "Policy edits are signed by the master and paid for by the fee sponsor."}</span>
    </section>
  );
}
