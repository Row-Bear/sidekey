import { Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { Authorizer, ChainContext, invoke, invokeAsSource, InvokeResult, read } from "./chain.js";
import { DEFAULT_RPC_URL, NATIVE_TOKEN_ID, requireEnv, STROOPS_PER_XLM } from "./config.js";
import { rpIdHash } from "./passkey.js";
import { optionLedgerScVal, parseSignerPolicy, rulesScVal, signerIdScVal, type SignerPolicyView } from "./policy.js";

export const FUND_AMOUNT = 9_500n * STROOPS_PER_XLM;
/** What the master keeps for fees and the account reserve while funding. */
const FUNDING_HEADROOM = 2n * STROOPS_PER_XLM;

// Testnet closes a ledger roughly every 5 seconds.
export const LEDGERS_PER_MINUTE = 12;
/** The delegate's validity window when the policy is set (about 30 minutes). */
export const DELEGATE_VALIDITY_LEDGERS = 30 * LEDGERS_PER_MINUTE;
/** Window used by the optional expiry demo (about 1 minute). */
export const SHORT_VALIDITY_LEDGERS = LEDGERS_PER_MINUTE;

/** Produces the smart account's signature somewhere else (a wallet, a passkey, a person). */
export type RemoteSign = (preimageXdr: string, payload: Uint8Array) => Promise<xdr.ScVal>;

/** A passkey acting as the delegate; its signatures always come from the browser. */
export interface DelegatePasskey {
  /** 65-byte uncompressed P-256 public key. */
  publicKey: Uint8Array;
  rpId: string;
  /** sha256 of `rpId`, as stored in the account's policy. */
  rpIdHash: Uint8Array;
}

export interface ScenarioContext extends ChainContext {
  /** Set when the delegate is a passkey instead of the demo's own key. */
  delegatePasskey?: DelegatePasskey;
  /**
   * True when the master is a connected wallet: `master` then has an address but no secret, and
   * everything the master signs goes through `remoteSigners` or `remoteTransactionSigner`.
   */
  walletMaster: boolean;
  /** Gets a transaction signed by the master G account (a wallet), for calls it authorizes as itself. */
  remoteTransactionSigner?: (unsignedXdr: string, summary: string[]) => Promise<string>;
  /**
   * When set for a role, that role's smart-account signatures come from here instead of the
   * server-held key. Calls the G account itself must authorize (step 2) still need the key.
   */
  remoteSigners?: Partial<Record<"master" | "delegate", RemoteSign>>;
  rpcUrl: string;
  master: Keypair;
  delegate: Keypair;
  smartAccountId: string;
  simId: string;
  nativeId: string;
}

export function createScenarioContext(env: Record<string, string | undefined> = process.env): ScenarioContext {
  const rpcUrl = env.RPC_URL ?? DEFAULT_RPC_URL;
  const walletMaster = env.MASTER_MODE === "wallet";
  const passkeyHex = env.DELEGATE_PASSKEY_PUBLIC;
  return {
    ...(passkeyHex && env.DELEGATE_PASSKEY_RP
      ? {
          delegatePasskey: {
            publicKey: Buffer.from(passkeyHex, "hex"),
            rpId: env.DELEGATE_PASSKEY_RP,
            rpIdHash: rpIdHash(env.DELEGATE_PASSKEY_RP),
          },
        }
      : {}),
    walletMaster,
    rpcUrl,
    server: new rpc.Server(rpcUrl),
    sponsor: Keypair.fromSecret(requireEnv("SPONSOR_SECRET", env)),
    master: walletMaster ? Keypair.fromPublicKey(requireEnv("MASTER_PUBLIC", env)) : Keypair.fromSecret(requireEnv("MASTER_SECRET", env)),
    delegate: Keypair.fromSecret(requireEnv("DELEGATE_SECRET", env)),
    smartAccountId: requireEnv("SMART_ACCOUNT_ID", env),
    simId: requireEnv("YIELD_SIM_CONTRACT_ID", env),
    nativeId: env.NATIVE_TOKEN_ID ?? NATIVE_TOKEN_ID,
  };
}

export interface Snapshot {
  /** All amounts are in stroops (1 XLM = 10^7), as decimal strings. */
  accountXlm: string;
  deposited: string;
  accruedYield: string;
}

export interface StepResult {
  step: number;
  name: string;
  signer: "master" | "delegate";
  expected: "success" | "failure";
  outcome: "success" | "failure";
  /** True when the outcome matches what the PoC expects for this step. */
  asExpected: boolean;
  txHash?: string;
  explorerUrl?: string;
  failureStage?: string;
  error?: string;
  note?: string;
  before: Snapshot;
  after: Snapshot;
  at: string;
}

interface StepSpec {
  name: string;
  signer: "master" | "delegate";
  expected: "success" | "failure";
  /** For an expected failure: the account's own error that must be the cause (not just any failure). */
  expectedError?: string;
  /** Not part of the core 7-step demo; run on request. */
  optional?: boolean;
  run: (ctx: ScenarioContext) => Promise<{ result: InvokeResult; note?: string }>;
}

const addr = (a: string) => new Address(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

const xlm = (stroops: bigint) => `${(Number(stroops) / Number(STROOPS_PER_XLM)).toLocaleString("en-US", { maximumFractionDigits: 7 })} XLM`;

const smartAuth = (ctx: ScenarioContext, who: "master" | "delegate"): Authorizer => {
  const remote = ctx.remoteSigners?.[who];
  if (who === "delegate" && ctx.delegatePasskey && !remote) {
    throw new Error("The delegate is a passkey: its signature must come from the browser");
  }
  if (who === "master" && ctx.walletMaster && !remote) {
    throw new Error("The master is a connected wallet: its signatures must come from the wallet, not the server");
  }
  return remote
    ? { kind: "smart-remote", address: ctx.smartAccountId, sign: remote }
    : { kind: "smart", address: ctx.smartAccountId, keypair: who === "master" ? ctx.master : ctx.delegate };
};

async function bigintView(ctx: ScenarioContext, contract: string, method: string, user: string): Promise<bigint> {
  return BigInt((await read(ctx, contract, method, [addr(user)])) as bigint);
}

export async function snapshot(ctx: ScenarioContext): Promise<Snapshot> {
  const [accountXlm, deposited, accruedYield] = await Promise.all([
    bigintView(ctx, ctx.nativeId, "balance", ctx.smartAccountId),
    bigintView(ctx, ctx.simId, "balance", ctx.smartAccountId),
    bigintView(ctx, ctx.simId, "accrued_yield", ctx.smartAccountId),
  ]);
  return { accountXlm: accountXlm.toString(), deposited: deposited.toString(), accruedYield: accruedYield.toString() };
}

export async function waitForYield(ctx: ScenarioContext, timeoutSeconds = 180): Promise<bigint> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const accrued = await bigintView(ctx, ctx.simId, "accrued_yield", ctx.smartAccountId);
    if (accrued > 0n) return accrued;
    if (Date.now() > deadline) throw new Error(`No yield accrued within ${timeoutSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

/** The delegate's public key: the passkey when there is one, otherwise the demo's key. */
export const delegateKey = (ctx: ScenarioContext): Uint8Array => ctx.delegatePasskey?.publicKey ?? ctx.delegate.rawPublicKey();

export async function latestLedger(ctx: ScenarioContext): Promise<number> {
  return (await ctx.server.getLatestLedger()).sequence;
}

export async function readDelegatePolicy(ctx: ScenarioContext): Promise<SignerPolicyView | null> {
  const native = await read(ctx, ctx.smartAccountId, "get_signer", [signerIdScVal(delegateKey(ctx))]);
  return native ? parseSignerPolicy(native) : null;
}

export async function waitForLedgerAfter(ctx: ScenarioContext, ledger: number, timeoutSeconds = 180): Promise<number> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const current = await latestLedger(ctx);
    if (current > ledger) return current;
    if (Date.now() > deadline) throw new Error(`Ledger ${ledger} not passed within ${timeoutSeconds}s`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function claim(ctx: ScenarioContext, who: "master" | "delegate") {
  const accrued = await waitForYield(ctx);
  const result = await invoke(ctx, {
    contractId: ctx.simId,
    method: "claim",
    args: [addr(ctx.smartAccountId)],
    authorizers: [smartAuth(ctx, who)],
  });
  return { result, note: `accrued yield before claim: ${xlm(accrued)}` };
}

async function withdraw(ctx: ScenarioContext, who: "master" | "delegate") {
  const deposited = await bigintView(ctx, ctx.simId, "balance", ctx.smartAccountId);
  const result = await invoke(ctx, {
    contractId: ctx.simId,
    method: "withdraw",
    args: [addr(ctx.smartAccountId), i128(deposited)],
    authorizers: [smartAuth(ctx, who)],
  });
  return { result, note: `withdrawing the full deposit of ${xlm(deposited)}` };
}

export const STEPS: StepSpec[] = [
  {
    name: "Master sets policy: delegate may call claim() on the yield simulator, for the account itself only, for about 30 minutes",
    signer: "master",
    expected: "success",
    run: async (ctx) => {
      const validUntil = (await latestLedger(ctx)) + DELEGATE_VALIDITY_LEDGERS;
      const rules = rulesScVal([{ contract: ctx.simId, function: "claim", args: [{ kind: "self" }] }]);
      const passkey = ctx.delegatePasskey;
      return {
        result: await invoke(ctx, {
          contractId: ctx.smartAccountId,
          method: passkey ? "set_passkey" : "set_signer",
          args: passkey
            ? [xdr.ScVal.scvBytes(Buffer.from(passkey.publicKey)), xdr.ScVal.scvBytes(Buffer.from(passkey.rpIdHash)), optionLedgerScVal(validUntil), rules]
            : [signerIdScVal(ctx.delegate.rawPublicKey()), optionLedgerScVal(validUntil), rules],
          authorizers: [smartAuth(ctx, "master")],
        }),
        note: `${passkey ? "passkey delegate" : "delegate"} valid until ledger ${validUntil}`,
      };
    },
  },
  {
    name: "Master account sends 9,500 XLM to the smart account",
    signer: "master",
    expected: "success",
    run: async (ctx) => {
      const have = await bigintView(ctx, ctx.nativeId, "balance", ctx.master.publicKey());
      const need = FUND_AMOUNT + FUNDING_HEADROOM;
      if (have < need) {
        return {
          result: {
            ok: false,
            stage: "simulation",
            error: `The master ${ctx.master.publicKey()} has ${xlm(have)} but this step sends ${xlm(FUND_AMOUNT)} and needs about ${xlm(FUNDING_HEADROOM)} for fees and reserve. Fund it, or move XLM back with the call builder.`,
          },
        };
      }
      const args = [addr(ctx.master.publicKey()), addr(ctx.smartAccountId), i128(FUND_AMOUNT)];
      if (!ctx.walletMaster) {
        return {
          result: await invoke(ctx, {
            contractId: ctx.nativeId,
            method: "transfer",
            args,
            authorizers: [{ kind: "classic", address: ctx.master.publicKey(), keypair: ctx.master }],
          }),
        };
      }
      // A wallet cannot sign a bare auth entry for its own G account here, so it signs the whole
      // transaction instead: it is the source, pays the fee, and its signature is the authorization.
      if (!ctx.remoteTransactionSigner) throw new Error("No wallet is available to sign the funding transaction");
      return {
        result: await invokeAsSource(ctx, {
          contractId: ctx.nativeId,
          method: "transfer",
          args,
          sourceAddress: ctx.master.publicKey(),
          signTransaction: ctx.remoteTransactionSigner,
        }),
        note: "signed by the wallet as a transaction",
      };
    },
  },
  {
    name: "deposit() all XLM into the yield simulator, signed by the master G key",
    signer: "master",
    expected: "success",
    run: async (ctx) => {
      const balance = await bigintView(ctx, ctx.nativeId, "balance", ctx.smartAccountId);
      return {
        result: await invoke(ctx, {
          contractId: ctx.simId,
          method: "deposit",
          args: [addr(ctx.smartAccountId), i128(balance)],
          authorizers: [smartAuth(ctx, "master")],
        }),
        note: `depositing ${xlm(balance)}`,
      };
    },
  },
  {
    name: "claim() signed by the master G key",
    signer: "master",
    expected: "success",
    run: (ctx) => claim(ctx, "master"),
  },
  {
    name: "claim() signed by the delegate, as named in the signing policy",
    signer: "delegate",
    expected: "success",
    run: (ctx) => claim(ctx, "delegate"),
  },
  {
    name: "withdraw() signed by the delegate is rejected by the policy",
    signer: "delegate",
    expected: "failure",
    expectedError: "NotAllowed",
    run: (ctx) => withdraw(ctx, "delegate"),
  },
  {
    name: "withdraw() signed by the master G key",
    signer: "master",
    expected: "success",
    run: (ctx) => withdraw(ctx, "master"),
  },
  {
    name: "Master shortens the delegate's expiry to about 1 minute",
    signer: "master",
    expected: "success",
    optional: true,
    run: async (ctx) => {
      const validUntil = (await latestLedger(ctx)) + SHORT_VALIDITY_LEDGERS;
      return {
        result: await invoke(ctx, {
          contractId: ctx.smartAccountId,
          method: "set_expiry",
          args: [signerIdScVal(delegateKey(ctx)), optionLedgerScVal(validUntil)],
          authorizers: [smartAuth(ctx, "master")],
        }),
        note: `delegate now valid until ledger ${validUntil}`,
      };
    },
  },
  {
    name: "claim() signed by the delegate after its expiry is rejected",
    signer: "delegate",
    expected: "failure",
    expectedError: "SignerExpired",
    optional: true,
    run: async (ctx) => {
      const policy = await readDelegatePolicy(ctx);
      if (policy?.validUntilLedger == null) throw new Error("The delegate has no expiry; run the previous step first");
      const accrued = await bigintView(ctx, ctx.simId, "accrued_yield", ctx.smartAccountId);
      // The call must reach the policy check, so the simulator must have something to claim.
      if (accrued === 0n) throw new Error("No accrued yield left to claim; run this on an account that has been through step 5");
      const ledger = await waitForLedgerAfter(ctx, policy.validUntilLedger);
      const result = await invoke(ctx, {
        contractId: ctx.simId,
        method: "claim",
        args: [addr(ctx.smartAccountId)],
        authorizers: [smartAuth(ctx, "delegate")],
      });
      return { result, note: `expired after ledger ${policy.validUntilLedger}; current ledger ${ledger}` };
    },
  },
];

/** The core demo is every step that is not optional (steps 1-7). */
export const CORE_STEP_COUNT = STEPS.filter((s) => !s.optional).length;

export async function runStep(ctx: ScenarioContext, step: number): Promise<StepResult> {
  const spec = STEPS[step - 1];
  if (!spec) throw new Error(`Unknown step ${step}; valid steps are 1-${STEPS.length}`);

  const before = await snapshot(ctx);
  const { result, note } = await spec.run(ctx);
  const after = await snapshot(ctx);
  const outcome = result.ok ? "success" : "failure";
  // A failure only counts when it is the failure the step is about, so an unrelated error cannot pass.
  const rightFailure = result.ok || !spec.expectedError || result.error.includes(spec.expectedError);

  return {
    step,
    name: spec.name,
    signer: spec.signer,
    expected: spec.expected,
    outcome,
    asExpected: outcome === spec.expected && rightFailure,
    ...(result.ok
      ? { txHash: result.hash, explorerUrl: `https://stellar.expert/explorer/testnet/tx/${result.hash}` }
      : { failureStage: result.stage, error: result.error }),
    ...(note ? { note } : {}),
    before,
    after,
    at: new Date().toISOString(),
  };
}
