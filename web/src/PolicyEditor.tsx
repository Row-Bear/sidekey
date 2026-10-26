import { useEffect, useState } from "react";
import type { ConstraintInput, ExpiryInput, PolicyOp, RuleView } from "@poc/core";
import { describeRule, expiryText, shortAddress, type SignersResponse } from "./api";
import { ArgInput } from "./ArgInput";
import type { SigningVia } from "./api-types";
import { useContractFunctions } from "./hooks";
import { SignWith } from "./SignWith";

const LEDGERS_PER_MINUTE = 12;
const OTHER = "other";

type ExpiryKind = "none" | "minutes" | "ledger";

function toExpiry(kind: ExpiryKind, value: string): ExpiryInput | null {
  if (kind === "none") return { kind: "none" };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return kind === "minutes" ? { kind: "minutes", minutes: n } : { kind: "ledger", ledger: Math.floor(n) };
}

export function PolicyEditor({ demo = true, data, busy, onApply }: {
  /** The guided demo can sign with the keys it holds; the plain page always signs in the browser. */
  demo?: boolean;
  data: SignersResponse | null;
  busy: boolean;
  onApply: (op: PolicyOp, via?: SigningVia) => void;
}) {
  const candidates = data?.signers.filter((s) => s.label !== "master") ?? [];
  const [choice, setChoice] = useState("");
  // Whether the user picked "another signer" themselves, as opposed to it being the fallback while there was none to pick.
  const [pickedOther, setPickedOther] = useState(false);
  const [otherAddress, setOtherAddress] = useState("");
  const [contract, setContract] = useState("");
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
    if (data && contract === "") setContract(data.simulator);
  }, [data, contract]);

  const { functions, loading, error } = useContractFunctions(contract);
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
  const exactMissing = constraints.some((c) => c.kind === "exact" && !(c.value ?? "").trim());
  const canAllow = !busy && signerRef !== "" && fn !== null && expiry !== null && !exactMissing;
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
                <code>{describeRule(rule)}</code> <span className="muted small">on {shortAddress(rule.contract)}</span>
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
      <label className="field">
        <span className="field-label">Contract id</span>
        <input value={contract} onChange={(e) => setContract(e.target.value)} spellCheck={false} placeholder="C…" />
        {error && <span className="error small">{error}</span>}
      </label>
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
          </div>
        );
      })}

      <div className="field">
        <span className="field-label">Expiry <span className="muted">(applied when the signer is first registered)</span></span>
        <span className="field-row">
          <select value={expiryKind} onChange={(e) => setExpiryKind(e.target.value as ExpiryKind)}>
            <option value="none">No expiry</option>
            <option value="minutes">In N minutes</option>
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
        {expiryKind === "minutes" && expiry?.kind === "minutes" && (
          <span className="muted hint">About ledger {(latest + Math.round(expiry.minutes * LEDGERS_PER_MINUTE)).toLocaleString("en-US")}</span>
        )}
        {expiry === null && <span className="error small">Enter a number greater than zero</span>}
      </div>

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
