// WP0 spike: master actions signed through a wallet that can only `signMessage` (SEP-53), as xBull can.
//
// The wallet is a faithful copy of xBull's algorithm (message read as base64 when it looks like
// base64, signature over sha256(prefix + bytes)); the master key is used ONLY inside that mock, never
// handed to the signing code, exactly as with a real wallet. Every master action below goes through
// the `Message` signature variant on a freshly deployed contract.
//
// Prerequisite: a funded fresh account, e.g. `npm run poc -- --fresh --to 2`.
// Run: npx tsx spikes/wallet-sep43/message.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import {
  createScenarioContext,
  invoke,
  latestLedger,
  LEDGERS_PER_MINUTE,
  type MessageWallet,
  optionLedgerScVal,
  read,
  SEP53_PREFIX,
  signerIdScVal,
  waitForYield,
  walletMessageSigner,
} from "@poc/core";

const XBULL_BASE64 = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;

function xbullLikeWallet(key: Keypair, log: string[]): MessageWallet {
  return {
    async signMessage(message) {
      log.push(message);
      const full = Buffer.concat([Buffer.from(SEP53_PREFIX), Buffer.from(message, XBULL_BASE64.test(message) ? "base64" : "utf8")]);
      return { signedMessage: Buffer.from(key.sign(createHash("sha256").update(full).digest())).toString("base64"), signerAddress: key.publicKey() };
    },
  };
}

const ctx = createScenarioContext();
const prompts: string[] = [];
const wallet = xbullLikeWallet(ctx.master, prompts);
const masterAddress = ctx.master.publicKey();
const authorizers = [
  {
    kind: "smart-remote" as const,
    address: ctx.smartAccountId,
    sign: walletMessageSigner(wallet, { account: ctx.smartAccountId, masterAddress }),
  },
];
const me = new Address(ctx.smartAccountId).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

async function step(label: string, params: Parameters<typeof invoke>[1]) {
  const result = await invoke(ctx, { ...params, authorizers });
  if (!result.ok) throw new Error(`${label}: ${result.stage}: ${result.error}`);
  console.log(`OK  ${label}  https://stellar.expert/explorer/testnet/tx/${result.hash}`);
  return result;
}

const native = ctx.nativeId;
const balance = async () => BigInt((await read(ctx, native, "balance", [me])) as bigint);
assert.ok((await balance()) > 0n, "fund the account first: npm run poc -- --fresh --to 2");

await step("set_expiry (admin call, master)", {
  contractId: ctx.smartAccountId,
  method: "set_expiry",
  args: [signerIdScVal(ctx.delegate.rawPublicKey()), optionLedgerScVal((await latestLedger(ctx)) + 30 * LEDGERS_PER_MINUTE)],
});

const funds = await balance();
await step("deposit all XLM (nested token transfer, master)", {
  contractId: ctx.simId,
  method: "deposit",
  args: [me, i128(funds)],
});
assert.equal(BigInt((await read(ctx, ctx.simId, "balance", [me])) as bigint), funds);

await waitForYield(ctx);
await step("claim (master)", { contractId: ctx.simId, method: "claim", args: [me] });

await waitForYield(ctx);
await step("withdraw all (master)", { contractId: ctx.simId, method: "withdraw", args: [me, i128(funds)] });
assert.equal(BigInt((await read(ctx, ctx.simId, "balance", [me])) as bigint), 0n);

console.log(`\n${prompts.length} wallet prompts; the first one read:\n  ${JSON.stringify(prompts[0])}`);
console.log("All master actions were authorized by SEP-53 message signatures.");
