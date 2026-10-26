// Checks the wallet-signs-a-transaction path on testnet: the master G account is the transaction
// source, a (mock) wallet signs the whole transaction through the broker, and the transfer lands.
// Run: npx tsx spikes/broker/transaction.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { Address, nativeToScVal, Networks, type Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { createScenarioContext, invokeAsSource, read, SignatureBroker } from "@poc/core";

const ctx = createScenarioContext();
const broker = new SignatureBroker();
const balance = async (id: string) => BigInt((await read(ctx, ctx.nativeId, "balance", [new Address(id).toScVal()])) as bigint);

// The mock wallet: waits for a pending request, signs the transaction with the master key, answers.
const wallet = (async () => {
  for (;;) {
    const [pending] = broker.pending();
    if (pending?.kind === "transaction") {
      const tx = TransactionBuilder.fromXDR(pending.transactionXdr, Networks.TESTNET);
      assert.equal((tx as Transaction).source, ctx.master.publicKey());
      console.log("wallet asked to sign:", pending.summary[0].slice(0, 80), "…");
      tx.sign(ctx.master);
      return broker.submit(pending.id, { kind: "transaction", signedXdr: tx.toXDR() });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
})();

const amount = 10_000_000n; // 1 XLM
const before = await balance(ctx.smartAccountId);
const result = await invokeAsSource(ctx, {
  contractId: ctx.nativeId,
  method: "transfer",
  args: [new Address(ctx.master.publicKey()).toScVal(), new Address(ctx.smartAccountId).toScVal(), nativeToScVal(amount, { type: "i128" })],
  sourceAddress: ctx.master.publicKey(),
  signTransaction: (xdr, summary) =>
    broker.requestTransaction({
      signerRaw: ctx.master.rawPublicKey(),
      signerLabel: "master",
      transactionXdr: xdr,
      networkPassphrase: Networks.TESTNET,
      summary,
    }),
});
assert.deepEqual(await wallet, { ok: true });
if (!result.ok) throw new Error(`${result.stage}: ${result.error}`);
const after = await balance(ctx.smartAccountId);
assert.equal(after - before, amount);
console.log(`smart account balance +${amount} stroops; https://stellar.expert/explorer/testnet/tx/${result.hash}`);
