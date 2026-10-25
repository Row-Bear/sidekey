import { Address, Keypair, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { Authorizer, ChainContext, invoke, InvokeResult, read } from "./chain.js";
import { DEFAULT_RPC_URL, NATIVE_TOKEN_ID, requireEnv, STROOPS_PER_XLM } from "./config.js";
import { optionLedgerScVal, parseSignerPolicy, rulesScVal, signerIdScVal, type SignerPolicyView } from "./policy.js";

export const FUND_AMOUNT = 9_500n * STROOPS_PER_XLM;

// Testnet closes a ledger roughly every 5 seconds.
export const LEDGERS_PER_MINUTE = 12;
/** The delegate's validity window when the policy is set (about 30 minutes). */
export const DELEGATE_VALIDITY_LEDGERS = 30 * LEDGERS_PER_MINUTE;
/** Window used by the optional expiry demo (about 1 minute). */
export const SHORT_VALIDITY_LEDGERS = LEDGERS_PER_MINUTE;

export interface ScenarioContext extends ChainContext {
  rpcUrl: string;
  master: Keypair;
  delegate: Keypair;
  smartAccountId: string;
  simId: string;
  nativeId: string;
}

export function createScenarioContext(env: Record<string, string | undefined> = process.env): ScenarioContext {
  const rpcUrl = env.RPC_URL ?? DEFAULT_RPC_URL;
  return {
    rpcUrl,
    server: new rpc.Server(rpcUrl),
    sponsor: Keypair.fromSecret(requireEnv("SPONSOR_SECRET", env)),
    master: Keypair.fromSecret(requireEnv("MASTER_SECRET", env)),
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

const smartAuth = (ctx: ScenarioContext, who: "master" | "delegate"): Authorizer => ({
  kind: "smart",
  address: ctx.smartAccountId,
  keypair: who === "master" ? ctx.master : ctx.delegate,
});

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

export async function latestLedger(ctx: ScenarioContext): Promise<number> {
  return (await ctx.server.getLatestLedger()).sequence;
}

export async function readDelegatePolicy(ctx: ScenarioContext): Promise<SignerPolicyView | null> {
  const native = await read(ctx, ctx.smartAccountId, "get_signer", [signerIdScVal(ctx.delegate.rawPublicKey())]);
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
      return {
        result: await invoke(ctx, {
          contractId: ctx.smartAccountId,
          method: "set_signer",
          args: [
            signerIdScVal(ctx.delegate.rawPublicKey()),
            optionLedgerScVal(validUntil),
            rulesScVal([{ contract: ctx.simId, function: "claim", args: [{ kind: "self" }] }]),
          ],
          authorizers: [smartAuth(ctx, "master")],
        }),
        note: `delegate valid until ledger ${validUntil}`,
      };
    },
  },
  {
    name: "Master account sends 9,500 XLM to the smart account",
    signer: "master",
    expected: "success",
    run: async (ctx) => ({
      result: await invoke(ctx, {
        contractId: ctx.nativeId,
        method: "transfer",
        args: [addr(ctx.master.publicKey()), addr(ctx.smartAccountId), i128(FUND_AMOUNT)],
        authorizers: [{ kind: "classic", address: ctx.master.publicKey(), keypair: ctx.master }],
      }),
    }),
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
          args: [signerIdScVal(ctx.delegate.rawPublicKey()), optionLedgerScVal(validUntil)],
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
