import { Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { Authorizer, ChainContext, invoke, InvokeResult, read } from "./chain.js";
import { DEFAULT_RPC_URL, NATIVE_TOKEN_ID, requireEnv, STROOPS_PER_XLM } from "./config.js";

export const FUND_AMOUNT = 9_500n * STROOPS_PER_XLM;

export interface ScenarioContext extends ChainContext {
  master: Keypair;
  delegate: Keypair;
  smartAccountId: string;
  simId: string;
  nativeId: string;
}

export function createScenarioContext(env: Record<string, string | undefined> = process.env): ScenarioContext {
  return {
    server: new rpc.Server(env.RPC_URL ?? DEFAULT_RPC_URL),
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
    name: "Master sets policy: delegate may call claim() on the yield simulator, for the account itself only",
    signer: "master",
    expected: "success",
    run: async (ctx) => ({
      result: await invoke(ctx, {
        contractId: ctx.smartAccountId,
        method: "add_policy",
        args: [
          nativeToScVal(ctx.delegate.rawPublicKey(), { type: "bytes" }),
          addr(ctx.simId),
          xdr.ScVal.scvSymbol("claim"),
          xdr.ScVal.scvBool(true),
        ],
        authorizers: [smartAuth(ctx, "master")],
      }),
    }),
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
    run: (ctx) => withdraw(ctx, "delegate"),
  },
  {
    name: "withdraw() signed by the master G key",
    signer: "master",
    expected: "success",
    run: (ctx) => withdraw(ctx, "master"),
  },
];

export async function runStep(ctx: ScenarioContext, step: number): Promise<StepResult> {
  const spec = STEPS[step - 1];
  if (!spec) throw new Error(`Unknown step ${step}; valid steps are 1-${STEPS.length}`);

  const before = await snapshot(ctx);
  const { result, note } = await spec.run(ctx);
  const after = await snapshot(ctx);
  const outcome = result.ok ? "success" : "failure";

  return {
    step,
    name: spec.name,
    signer: spec.signer,
    expected: spec.expected,
    outcome,
    asExpected: outcome === spec.expected,
    ...(result.ok
      ? { txHash: result.hash, explorerUrl: `https://stellar.expert/explorer/testnet/tx/${result.hash}` }
      : { failureStage: result.stage, error: result.error }),
    ...(note ? { note } : {}),
    before,
    after,
    at: new Date().toISOString(),
  };
}
