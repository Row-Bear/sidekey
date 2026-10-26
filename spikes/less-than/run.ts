// Testnet check of the "less than" argument constraint, using the same core functions the dashboard uses.
// Everything happens in memory: a throwaway master key, a new smart account (deployed from the built wasm) and
// the demo's delegate key; `.env` and the dashboard's session are not touched.
//
//   1. a new account takes a rule `transfer(this account, any, < 1 XLM)` for the delegate,
//   2. the delegate's transfers below the limit succeed and ones at or above it are refused on chain,
//   3. the dashboard's preview agrees with the chain on every case,
//   4. an account deployed before the constraint existed refuses the rule (no state is changed).
//
// Run: npx tsx spikes/less-than/run.ts   (needs `npm run build:contract` first)
import "dotenv/config";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, Keypair, Networks, type Transaction, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import {
  accountFeatures,
  createScenarioContext,
  deploySmartAccount,
  describeRule,
  fundWithFriendbot,
  invokeAsSource,
  listSigners,
  previewCall,
  requireEnv,
  runCall,
  runPolicyOp,
  WASM_RELATIVE_PATH,
} from "@poc/core";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LIMIT = 10_000_000n; // 1 XLM, in stroops

console.log("deploying a new smart account from", WASM_RELATIVE_PATH);
const master = Keypair.random();
await fundWithFriendbot(master.publicKey());
const { contractId } = await deploySmartAccount({
  sponsorSecret: requireEnv("SPONSOR_SECRET"),
  masterPublic: master.publicKey(),
  wasmPath: join(ROOT, WASM_RELATIVE_PATH),
  cwd: ROOT,
});
console.log("account:", contractId);

const ctx = createScenarioContext({ ...process.env, MASTER_SECRET: master.secret(), MASTER_PUBLIC: master.publicKey(), SMART_ACCOUNT_ID: contractId });
const native = ctx.nativeId;
const delegate = ctx.delegate.publicKey();

// The account needs some XLM to move: the master sends it 5 XLM (its own transaction, signed by the master).
const funded = await invokeAsSource(ctx, {
  contractId: native,
  method: "transfer",
  args: [new Address(master.publicKey()).toScVal(), new Address(contractId).toScVal(), nativeToScVal(50_000_000n, { type: "i128" })],
  sourceAddress: master.publicKey(),
  signTransaction: async (xdr) => {
    const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction;
    tx.sign(master);
    return tx.toXDR();
  },
});
assert.equal(funded.ok, true, JSON.stringify(funded));
console.log("funded the account with 5 XLM");

// 1. The rule: the delegate may move less than 1 XLM from the account, to anyone.
const registered = await runPolicyOp(ctx, {
  op: "allow",
  signer: delegate,
  contract: native,
  function: "transfer",
  constraints: [{ kind: "self" }, { kind: "any" }, { kind: "lessThan", value: LIMIT.toString() }],
  expiry: { kind: "minutes", minutes: 30 },
});
assert.equal(registered.outcome, "success", registered.error);
console.log("rule registered:", registered.title);

const signers = await listSigners(ctx);
const rule = signers.find((s) => s.address === delegate)?.policy?.rules[0];
assert.ok(rule, "the delegate's rule must be readable from chain");
assert.equal(describeRule(rule), `transfer(this account, any, < ${LIMIT})`);
assert.deepEqual(rule.args[2], { kind: "lessThan", limit: LIMIT.toString() });
console.log("read back from chain:", describeRule(rule));

// 2 and 3. Each case is previewed (the dashboard's check) and then sent for real.
const cases: [string, bigint, boolean][] = [
  ["just below the limit", LIMIT - 1n, true],
  ["well below the limit", 5_000_000n, true],
  ["exactly the limit", LIMIT, false],
  ["above the limit", 20_000_000n, false],
];
for (const [what, amount, allowed] of cases) {
  const req = { contract: native, function: "transfer", args: [contractId, master.publicKey(), amount.toString()], signer: delegate };
  const preview = await previewCall(ctx, req);
  const record = await runCall(ctx, req);
  console.log(`${what} (${amount}): preview ${preview.status}, chain ${record.outcome}${record.error ? ` (${record.error.slice(-60)})` : ""}`);
  assert.equal(preview.status, allowed ? "allowed" : "rejected", `${what}: preview`);
  assert.equal(record.outcome, allowed ? "success" : "failure", `${what}: chain`);
  if (!allowed) {
    assert.equal(record.rejectedByPolicy, true, `${what}: must be refused by the policy, not by something else`);
    assert.match(record.error ?? "", /NotAllowed/, `${what}: error`);
  }
}

// 4. An account from before this change (the one in .env) reports that it lacks the feature, and registering the rule
// is refused up front with an explanation, before anything is sent.
assert.deepEqual(await accountFeatures(ctx), { lessThan: true });
const oldCtx = createScenarioContext(process.env);
assert.deepEqual(await accountFeatures(oldCtx), { lessThan: false }, "the account in .env was deployed before LessThan existed");
const refused = await runPolicyOp(oldCtx, {
  op: "allow",
  signer: delegate,
  contract: native,
  function: "transfer",
  constraints: [{ kind: "self" }, { kind: "any" }, { kind: "lessThan", value: "5" }],
  expiry: { kind: "none" },
});
console.log("old account:", refused.outcome, "-", refused.error?.slice(0, 90));
assert.equal(refused.outcome, "failure");
assert.equal(refused.txHash, undefined, "nothing may be submitted");
assert.match(refused.error ?? "", /deployed before the "less than" constraint existed/);

console.log("\nLESS THAN CONSTRAINT VERIFIED ON TESTNET");
