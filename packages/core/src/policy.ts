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

/**
 * `SignerId` for a raw public key: a 32-byte ed25519 key, or a 65-byte uncompressed secp256r1 key
 * (a passkey).
 */
export function signerIdScVal(publicKey: Uint8Array): xdr.ScVal {
  if (publicKey.length !== 32 && publicKey.length !== 65) {
    throw new Error(`A signer key is 32 bytes (ed25519) or 65 bytes (passkey), not ${publicKey.length}`);
  }
  return variant(publicKey.length === 65 ? "Passkey" : "Ed25519", xdr.ScVal.scvBytes(Buffer.from(publicKey)));
}

/** `Passkey(PasskeySignature { authenticator_data, client_data_json, public_key, sig })`; `sig` is compact low-S. */
export function passkeySignatureScVal(parts: {
  publicKey: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJson: Uint8Array;
  signature: Uint8Array;
}): xdr.ScVal {
  const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
  return variant(
    "Passkey",
    xdr.ScVal.scvMap([
      field("authenticator_data", bytes(parts.authenticatorData)),
      field("client_data_json", bytes(parts.clientDataJson)),
      field("public_key", bytes(parts.publicKey)),
      field("sig", bytes(parts.signature)),
    ]),
  );
}

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

/** `Message(Ed25519Signature { sig, signer })`: a SEP-53 message signature (see `walletMessage`). */
export function messageSignatureScVal(rawPublicKey: Uint8Array, signature: Uint8Array): xdr.ScVal {
  const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
  return variant(
    "Message",
    xdr.ScVal.scvMap([field("sig", bytes(signature)), field("signer", bytes(rawPublicKey))]),
  );
}

// ---- Decoding what the contract returns, in a JSON-safe shape for the UI ----

export type ArgConstraintView =
  | { kind: "any" }
  | { kind: "self" }
  | { kind: "exact"; display: string; /** XDR of the required value, hex-encoded. */ xdrHex: string };

export interface RuleView {
  contract: string;
  function: string;
  args: ArgConstraintView[];
}

export interface SignerPolicyView {
  /** Last ledger (inclusive) in which the signer is accepted; null means no expiry. */
  validUntilLedger: number | null;
  /** For a passkey: sha256 of its relying party id, hex. Null for other signers. */
  rpIdHashHex: string | null;
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
  if (name === "Exact" && payload) {
    return { kind: "exact", display: describeExact(payload), xdrHex: Buffer.from(payload).toString("hex") };
  }
  throw new Error(`Unknown argument constraint ${String(name)}`);
}

/** Decodes the native value of `get_signer` (`SignerPolicy`). */
export function parseSignerPolicy(native: unknown): SignerPolicyView {
  const policy = native as {
    valid_until_ledger?: number | null;
    rp_id_hash?: Uint8Array | null;
    rules: { contract: string; function: string; args: unknown[] }[];
  };
  return {
    validUntilLedger: policy.valid_until_ledger ?? null,
    rpIdHashHex: policy.rp_id_hash ? Buffer.from(policy.rp_id_hash).toString("hex") : null,
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

// ---- Previewing a call against a signer's policy (mirrors the contract's checks) ----

/** One invocation that the smart account is asked to authorize. */
export type CallContext =
  | { kind: "contract"; contract: string; function: string; args: xdr.ScVal[] }
  // Contract deployments and other host functions; a delegate can never authorize these.
  | { kind: "other"; description: string };

export type Verdict =
  | { allowed: true }
  | { allowed: false; error: "UnknownSigner" | "SignerExpired" | "NotAllowed"; reason: string };

function addressOf(value: xdr.ScVal): string | null {
  try {
    return Address.fromScVal(value).toString();
  } catch {
    return null;
  }
}

/** Why `args` do not satisfy `rule`, or null when they do. */
function mismatch(rule: RuleView, args: xdr.ScVal[], account: string): string | null {
  if (rule.args.length !== args.length) {
    return `${rule.function}() is allowed with ${rule.args.length} argument(s), this call has ${args.length}`;
  }
  for (const [i, constraint] of rule.args.entries()) {
    if (constraint.kind === "self" && addressOf(args[i]) !== account) {
      return `argument ${i + 1} must be this account`;
    }
    if (constraint.kind === "exact" && Buffer.from(args[i].toXDR()).toString("hex") !== constraint.xdrHex) {
      return `argument ${i + 1} must equal ${constraint.display}`;
    }
  }
  return null;
}

/**
 * Evaluates what the contract's `__check_auth` would decide for a non-master signer. The master
 * is always allowed and needs no evaluation. This is a preview; the on-chain check is authoritative.
 */
export function evaluateCalls(
  policy: SignerPolicyView | null,
  calls: CallContext[],
  account: string,
  latestLedger: number,
): Verdict {
  const deny = (error: "UnknownSigner" | "SignerExpired" | "NotAllowed", reason: string): Verdict => ({
    allowed: false,
    error,
    reason,
  });
  if (policy === null) return deny("UnknownSigner", "this signer is not registered on the account");
  if (policy.validUntilLedger !== null && latestLedger > policy.validUntilLedger) {
    return deny("SignerExpired", `this signer expired at ledger ${policy.validUntilLedger}`);
  }

  for (const call of calls) {
    if (call.kind === "other") return deny("NotAllowed", `${call.description} cannot be authorized by a delegate`);
    if (call.contract === account) return deny("NotAllowed", "a delegate cannot authorize calls on the account itself");

    const sameFunction = policy.rules.filter((r) => r.contract === call.contract && r.function === call.function);
    if (sameFunction.length === 0) {
      return deny("NotAllowed", `no rule allows ${call.function}() on ${call.contract}`);
    }
    const reasons = sameFunction.map((rule) => mismatch(rule, call.args, account));
    if (!reasons.includes(null)) {
      return deny("NotAllowed", `${call.function}() is allowed, but ${reasons[0]}`);
    }
  }
  return { allowed: true };
}

const showValue = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? `0x${Buffer.from(v).toString("hex")}` : v));

/** One line per invocation, e.g. `claim(CBG6…) on CDGO…`. */
export function describeCall(call: CallContext): string {
  return call.kind === "other"
    ? call.description
    : `${call.function}(${call.args.map((a) => showValue(scValToNative(a)).replace(/^"|"$/g, "")).join(", ")}) on ${call.contract}`;
}
