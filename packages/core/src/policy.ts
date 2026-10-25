import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

// Encoders and decoders for the smart account's policy types (contract v2). Pure and
// browser-safe: no filesystem or network access.

export type ArgConstraintInput =
  | { kind: "any" }
  | { kind: "self" }
  | { kind: "exact"; value: xdr.ScVal };

export interface RuleInput {
  contract: string;
  function: string;
  args: ArgConstraintInput[];
}

const variant = (name: string, ...values: xdr.ScVal[]) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), ...values]);

const field = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

/** `SignerId::Ed25519(BytesN<32>)` for a raw ed25519 public key. */
export const signerIdScVal = (rawPublicKey: Uint8Array): xdr.ScVal =>
  variant("Ed25519", xdr.ScVal.scvBytes(Buffer.from(rawPublicKey)));

export function argConstraintScVal(constraint: ArgConstraintInput): xdr.ScVal {
  switch (constraint.kind) {
    case "any":
      return variant("Any");
    case "self":
      return variant("SelfAddress");
    case "exact":
      return variant("Exact", xdr.ScVal.scvBytes(constraint.value.toXDR()));
  }
}

/** `Rule { args, contract, function }`; struct fields must be in key order. */
export const ruleScVal = (rule: RuleInput): xdr.ScVal =>
  xdr.ScVal.scvMap([
    field("args", xdr.ScVal.scvVec(rule.args.map(argConstraintScVal))),
    field("contract", new Address(rule.contract).toScVal()),
    field("function", xdr.ScVal.scvSymbol(rule.function)),
  ]);

export const rulesScVal = (rules: RuleInput[]): xdr.ScVal => xdr.ScVal.scvVec(rules.map(ruleScVal));

/** `Option<u32>`: a ledger number, or void for none. */
export const optionLedgerScVal = (ledger: number | null): xdr.ScVal =>
  ledger === null ? xdr.ScVal.scvVoid() : nativeToScVal(ledger, { type: "u32" });

/** `Ed25519(Ed25519Signature { sig, signer })` as expected by the account's `__check_auth`. */
export function ed25519SignatureScVal(rawPublicKey: Uint8Array, signature: Uint8Array): xdr.ScVal {
  const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
  return variant(
    "Ed25519",
    xdr.ScVal.scvMap([field("sig", bytes(signature)), field("signer", bytes(rawPublicKey))]),
  );
}

// ---- Decoding what the contract returns, in a JSON-safe shape for the UI ----

export type ArgConstraintView = { kind: "any" } | { kind: "self" } | { kind: "exact"; display: string };

export interface RuleView {
  contract: string;
  function: string;
  args: ArgConstraintView[];
}

export interface SignerPolicyView {
  /** Last ledger (inclusive) in which the signer is accepted; null means no expiry. */
  validUntilLedger: number | null;
  rules: RuleView[];
}

function describeExact(xdrBytes: Uint8Array): string {
  try {
    const native = scValToNative(xdr.ScVal.fromXDR(Buffer.from(xdrBytes)));
    return typeof native === "object" ? JSON.stringify(native, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : String(native);
  } catch {
    return `0x${Buffer.from(xdrBytes).toString("hex")}`;
  }
}

function parseConstraint(native: unknown): ArgConstraintView {
  const [name, payload] = native as [string, Uint8Array | undefined];
  if (name === "Any") return { kind: "any" };
  if (name === "SelfAddress") return { kind: "self" };
  if (name === "Exact" && payload) return { kind: "exact", display: describeExact(payload) };
  throw new Error(`Unknown argument constraint ${String(name)}`);
}

/** Decodes the native value of `get_signer` (`SignerPolicy`). */
export function parseSignerPolicy(native: unknown): SignerPolicyView {
  const policy = native as {
    valid_until_ledger?: number | null;
    rules: { contract: string; function: string; args: unknown[] }[];
  };
  return {
    validUntilLedger: policy.valid_until_ledger ?? null,
    rules: policy.rules.map((rule) => ({
      contract: rule.contract,
      function: rule.function,
      args: rule.args.map(parseConstraint),
    })),
  };
}

/** Human-readable constraint list, e.g. `claim(this account)` or `withdraw(this account, any)`. */
export function describeRule(rule: RuleView): string {
  const args = rule.args.map((a) => (a.kind === "self" ? "this account" : a.kind === "any" ? "any" : `= ${a.display}`));
  return `${rule.function}(${args.join(", ")})`;
}
