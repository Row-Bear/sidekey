import { randomUUID } from "node:crypto";
import { Address, Keypair, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { type Authorizer, invoke, type InvokeResult, read, recordAuthContexts } from "./chain.js";
import type { CallRecord } from "./history.js";
import {
  type CallContext,
  describeCall,
  describeRule,
  evaluateCalls,
  optionLedgerScVal,
  parseSignerPolicy,
  type RuleInput,
  ruleScVal,
  rulesScVal,
  signerIdScVal,
  type SignerPolicyView,
} from "./policy.js";
import { latestLedger, LEDGERS_PER_MINUTE, type ScenarioContext } from "./scenario.js";
import { argKind, describeFunctions, encodeArg, encodeArgs, loadSpec } from "./spec.js";

// What the dashboard's policy editor and call builder do on the server: list signers, preview a
// call against a signer's policy, send a call as a chosen signer, and let the master edit policy.

const POLICY_ERRORS = ["NotAllowed", "SignerExpired", "UnknownSigner"];

export interface SignerView {
  /** "master", or the hex of the signer's raw ed25519 public key. */
  id: string;
  label: "master" | "delegate" | "other";
  /** The signer's G address. */
  address: string;
  /** True when this demo holds the key and can sign for it. */
  hasKey: boolean;
  registered: boolean;
  /** Null for the master (no rules) and for signers that are not registered. */
  policy: SignerPolicyView | null;
}

/**
 * Where a call's signatures come from. By default the demo signs with the keys it holds; a browser
 * provider (wallet, passkey) returns authorizers that ask the browser instead.
 */
export type SigningSource = (signer: { id: string; label: string; raw: Uint8Array }) => Authorizer[];

const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** Accepts "master", a G address, or 64 hex characters. */
function parseSigner(ref: string): { id: string; raw: Uint8Array | null } {
  const text = ref.trim();
  if (text === "master") return { id: "master", raw: null };
  if (StrKey.isValidEd25519PublicKey(text)) {
    const raw = StrKey.decodeEd25519PublicKey(text);
    return { id: hexOf(raw), raw };
  }
  if (/^[0-9a-fA-F]{64}$/.test(text)) return { id: text.toLowerCase(), raw: Buffer.from(text, "hex") };
  throw new Error(`"${text}" is not "master", a G address or a 64-character hex key`);
}

async function readPolicy(ctx: ScenarioContext, raw: Uint8Array): Promise<SignerPolicyView | null> {
  const native = await read(ctx, ctx.smartAccountId, "get_signer", [signerIdScVal(raw)]);
  return native ? parseSignerPolicy(native) : null;
}

/** The master, every signer registered on the account, and the demo delegate even before it is registered. */
export async function listSigners(ctx: ScenarioContext): Promise<SignerView[]> {
  const delegateRaw = ctx.delegate.rawPublicKey();
  const registered = ((await read(ctx, ctx.smartAccountId, "list_signers")) as [string, Uint8Array][]).map(([, key]) => key);
  const rawKeys = [...registered];
  if (!rawKeys.some((k) => hexOf(k) === hexOf(delegateRaw))) rawKeys.push(delegateRaw);

  const signers: SignerView[] = [
    { id: "master", label: "master", address: ctx.master.publicKey(), hasKey: true, registered: true, policy: null },
  ];
  for (const raw of rawKeys) {
    const isDelegate = hexOf(raw) === hexOf(delegateRaw);
    const policy = await readPolicy(ctx, raw);
    signers.push({
      id: hexOf(raw),
      label: isDelegate ? "delegate" : "other",
      address: StrKey.encodeEd25519PublicKey(Buffer.from(raw)),
      hasKey: isDelegate,
      registered: policy !== null,
      policy,
    });
  }
  return signers;
}

function keyFor(ctx: ScenarioContext, id: string): Keypair | null {
  if (id === "master") return ctx.master;
  return id === hexOf(ctx.delegate.rawPublicKey()) ? ctx.delegate : null;
}

const labelFor = (ctx: ScenarioContext, id: string) =>
  id === "master" ? "master" : id === hexOf(ctx.delegate.rawPublicKey()) ? "delegate" : `${id.slice(0, 8)}…`;

function authorizersFor(ctx: ScenarioContext, id: string, key: Keypair): Authorizer[] {
  const authorizers: Authorizer[] = [{ kind: "smart", address: ctx.smartAccountId, keypair: key }];
  // The master key is also the G account, which may be asked to authorize its own transfers.
  if (id === "master") authorizers.push({ kind: "classic", address: ctx.master.publicKey(), keypair: ctx.master });
  return authorizers;
}

// ---- Calls ----

export interface CallRequest {
  contract: string;
  function: string;
  /** One text input per argument, in order. */
  args: string[];
  /** "master" or a signer's hex key. */
  signer: string;
}

export type PreviewResult =
  | { status: "allowed"; message: string; tree: string[] }
  | { status: "rejected"; message: string; error: string; tree: string[] }
  | { status: "simulation-failed"; message: string }
  | { status: "invalid"; message: string };

/**
 * Finds the contract that raised a contract error in a simulator error log. Only an event whose own
 * topic is the contract error counts: a failed `__check_auth` also mentions an `Error(Contract, #N)`,
 * but that code belongs to the smart account, not to the contract named on the same line.
 */
export function contractErrorSource(detail: string): { contractId: string; code: number } | null {
  const match = detail.match(/contract:(C[A-Z2-7]{55}), topics:\[error, Error\(Contract, #(\d+)\)\]/);
  return match ? { contractId: match[1], code: Number(match[2]) } : null;
}

/**
 * Turns `Error(Contract, #2)` into the contract's own error name (for example
 * `InsufficientDeposit (#2)`), using the error cases in the spec of the contract that raised it.
 */
async function explainFailure(ctx: ScenarioContext, error: string, detail?: string): Promise<string> {
  // An account rejection is already explained by `invoke` (it names the account's own error).
  if (error.includes("__check_auth")) return error;
  const source = contractErrorSource(detail ?? error);
  if (!source) return error;
  try {
    const cases = (await loadSpec(ctx.rpcUrl, source.contractId)).errorCases();
    const match = cases.find((c) => c.value === source.code);
    return match ? `${match.name.toString()} (#${source.code}) from ${source.contractId}` : error;
  } catch {
    return error;
  }
}

async function prepareCall(ctx: ScenarioContext, req: CallRequest) {
  const spec = await loadSpec(ctx.rpcUrl, req.contract);
  return { contractId: req.contract, method: req.function, args: encodeArgs(spec, req.function, req.args) };
}

/** Checks a call against the chosen signer's policy without signing or submitting anything. */
export async function previewCall(ctx: ScenarioContext, req: CallRequest): Promise<PreviewResult> {
  let params;
  try {
    params = await prepareCall(ctx, req);
  } catch (err) {
    return { status: "invalid", message: err instanceof Error ? err.message : String(err) };
  }

  const recorded = await recordAuthContexts(ctx, params, ctx.smartAccountId);
  if (!recorded.ok) return { status: "simulation-failed", message: await explainFailure(ctx, recorded.error, recorded.detail) };
  const tree = recorded.calls.map(describeCall);

  const signer = parseSigner(req.signer);
  if (signer.id === "master") {
    return { status: "allowed", message: "The master can authorize any call.", tree };
  }
  const verdict = evaluateCalls(await readPolicy(ctx, signer.raw!), recorded.calls, ctx.smartAccountId, await latestLedger(ctx));
  if (verdict.allowed) {
    return {
      status: "allowed",
      message: recorded.calls.length === 0
        ? "This call needs no authorization from the smart account."
        : "The signer's policy allows every call in the authorization tree.",
      tree,
    };
  }
  return { status: "rejected", message: `${verdict.error}: ${verdict.reason}`, error: verdict.error, tree };
}

function toRecord(
  base: Pick<CallRecord, "kind" | "title" | "signer">,
  result: InvokeResult,
): CallRecord {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    ...base,
    outcome: result.ok ? "success" : "failure",
    ...(result.ok
      ? { txHash: result.hash, explorerUrl: `https://stellar.expert/explorer/testnet/tx/${result.hash}` }
      : {
          failureStage: result.stage,
          error: result.error,
          rejectedByPolicy: POLICY_ERRORS.some((e) => result.error.includes(e)),
        }),
  };
}

function failure(base: Pick<CallRecord, "kind" | "title" | "signer">, message: string, stage: string): CallRecord {
  return toRecord(base, { ok: false, stage: stage as "simulation", error: message });
}

/** Sends a call signed by the chosen signer (only signers whose key this demo holds). */
export async function runCall(ctx: ScenarioContext, req: CallRequest, signing?: SigningSource): Promise<CallRecord> {
  const signer = parseSigner(req.signer);
  const base = { kind: "call" as const, title: `${req.function}(${req.args.join(", ")})`, signer: labelFor(ctx, signer.id) };
  const key = signing ? null : keyFor(ctx, signer.id);
  if (!signing && !key) return failure(base, "This demo does not hold a key for that signer", "signing");

  let params;
  try {
    params = await prepareCall(ctx, req);
  } catch (err) {
    return failure(base, err instanceof Error ? err.message : String(err), "input");
  }
  try {
    const authorizers = signing
      ? signing({ id: signer.id, label: base.signer, raw: signer.raw ?? ctx.master.rawPublicKey() })
      : authorizersFor(ctx, signer.id, key!);
    const result = await invoke(ctx, { ...params, authorizers });
    return toRecord(base, result.ok ? result : { ...result, error: await explainFailure(ctx, result.error, result.detail) });
  } catch (err) {
    return failure(base, err instanceof Error ? err.message : String(err), "signing");
  }
}

// ---- Policy edits (always signed by the master) ----

export interface ConstraintInput {
  kind: "any" | "self" | "exact";
  /** For "exact": the value, typed as for the call builder. */
  value?: string;
}

export type ExpiryInput = { kind: "none" } | { kind: "minutes"; minutes: number } | { kind: "ledger"; ledger: number };

export type PolicyOp =
  | { op: "allow"; signer: string; contract: string; function: string; constraints: ConstraintInput[]; expiry?: ExpiryInput }
  | { op: "remove-rule"; signer: string; contract: string; function: string }
  | { op: "set-expiry"; signer: string; expiry: ExpiryInput }
  | { op: "revoke"; signer: string };

async function resolveExpiry(ctx: ScenarioContext, expiry: ExpiryInput | undefined): Promise<number | null> {
  if (!expiry || expiry.kind === "none") return null;
  if (expiry.kind === "ledger") {
    if (!Number.isInteger(expiry.ledger) || expiry.ledger <= 0) throw new Error("expiry ledger must be a positive whole number");
    return expiry.ledger;
  }
  if (!(expiry.minutes > 0)) throw new Error("expiry minutes must be greater than zero");
  return (await latestLedger(ctx)) + Math.max(1, Math.round(expiry.minutes * LEDGERS_PER_MINUTE));
}

async function buildRule(ctx: ScenarioContext, op: Extract<PolicyOp, { op: "allow" }>): Promise<RuleInput> {
  const spec = await loadSpec(ctx.rpcUrl, op.contract);
  const fn = spec.getFunc(op.function);
  if (op.constraints.length !== fn.inputs.length) {
    throw new Error(`${op.function} takes ${fn.inputs.length} argument(s); give one constraint for each`);
  }
  const args = fn.inputs.map((input, i): RuleInput["args"][number] => {
    const name = input.name.toString();
    const constraint = op.constraints[i];
    if (constraint.kind === "any") return { kind: "any" };
    if (constraint.kind === "self") {
      if (argKind(input.type) !== "address") throw new Error(`${name}: "this account" only applies to address arguments`);
      return { kind: "self" };
    }
    return { kind: "exact", value: encodeArg(spec, name, input.type, constraint.value ?? "") };
  });
  return { contract: op.contract, function: op.function, args };
}

function describePolicyOp(ctx: ScenarioContext, op: PolicyOp): string {
  const who = labelFor(ctx, parseSigner(op.signer).id);
  switch (op.op) {
    case "allow": {
      const view = {
        contract: op.contract,
        function: op.function,
        args: op.constraints.map((c) =>
          c.kind === "exact" ? { kind: "exact" as const, display: c.value ?? "", xdrHex: "" } : { kind: c.kind },
        ),
      };
      return `Allow ${who}: ${describeRule(view)}`;
    }
    case "remove-rule":
      return `Remove ${who}'s rule for ${op.function}()`;
    case "set-expiry":
      return `Set ${who}'s expiry (${op.expiry.kind === "none" ? "none" : op.expiry.kind === "minutes" ? `in ${op.expiry.minutes} min` : `ledger ${op.expiry.ledger}`})`;
    case "revoke":
      return `Revoke ${who}`;
  }
}

/** Applies a policy edit on the smart account, signed by the master. */
export async function runPolicyOp(ctx: ScenarioContext, op: PolicyOp, signing?: SigningSource): Promise<CallRecord> {
  const base = { kind: "policy" as const, title: "", signer: "master" };
  try {
    const signer = parseSigner(op.signer);
    if (signer.id === "master" || !signer.raw) throw new Error("The master has no policy; pick a delegate signer");
    base.title = describePolicyOp(ctx, op);
    const signerId = signerIdScVal(signer.raw);
    const authorizers = signing
      ? signing({ id: "master", label: "master", raw: ctx.master.rawPublicKey() })
      : authorizersFor(ctx, "master", ctx.master);

    let method: string;
    let args: xdr.ScVal[];
    switch (op.op) {
      case "allow": {
        const rule = await buildRule(ctx, op);
        const existing = await readPolicy(ctx, signer.raw);
        if (existing === null) {
          method = "set_signer";
          args = [signerId, optionLedgerScVal(await resolveExpiry(ctx, op.expiry)), rulesScVal([rule])];
        } else {
          method = "add_rule";
          args = [signerId, ruleScVal(rule)];
        }
        break;
      }
      case "remove-rule":
        method = "remove_rule";
        args = [signerId, new Address(op.contract).toScVal(), xdr.ScVal.scvSymbol(op.function)];
        break;
      case "set-expiry":
        method = "set_expiry";
        args = [signerId, optionLedgerScVal(await resolveExpiry(ctx, op.expiry))];
        break;
      case "revoke":
        method = "revoke_signer";
        args = [signerId];
        break;
    }
    return toRecord(base, await invoke(ctx, { contractId: ctx.smartAccountId, method, args, authorizers }));
  } catch (err) {
    return failure({ ...base, title: base.title || `Policy edit (${op.op})` }, err instanceof Error ? err.message : String(err), "input");
  }
}

/** Function list for a contract, for both forms. */
export async function contractFunctions(ctx: ScenarioContext, contractId: string) {
  return describeFunctions(await loadSpec(ctx.rpcUrl, contractId));
}
