// Spike: can a smart account be created and used with no server and no fee payer of our own?
//
//   1. A brand-new G key (funded once by friendbot, as a wallet's account would already be) asks the on-chain factory
//      for its smart account. It signs one transaction it is the source of, as any wallet can; OpenZeppelin's Channels
//      service wraps it in a fee bump and pays.
//   2. The account exists at the address the factory predicted, with that key as its master.
//   3. A policy change on the new account (signed by the master through the account's own __check_auth) also goes
//      through Channels.
//
// Finding: a G account that does not exist on chain cannot authorize anything (`require_auth` fails with
// "trying to get non-existing value for account"), so the master must have been created once, but it never pays fees.
//
// Everything happens in memory; `.env` and the dashboard's session are not touched.
// Run: npx tsx spikes/factory/run.ts   (needs FACTORY_ID and CHANNELS_API_KEY in .env)
import "dotenv/config";
import assert from "node:assert/strict";
import { Address, Keypair, Networks, type Transaction, TransactionBuilder, type xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels";
import { createAccountViaFactory, createScenarioContext, factoryAccountAddress, findFactoryAccounts, fundWithFriendbot, read, requireEnv, runPolicyOp, type Relay } from "@poc/core";

const CHANNELS_URL = process.env.CHANNELS_URL ?? "https://channels.openzeppelin.com/testnet";
const client = new ChannelsClient({ baseUrl: CHANNELS_URL, apiKey: requireEnv("CHANNELS_API_KEY") });
const factory = requireEnv("FACTORY_ID");

const relay: Relay = async (func: xdr.HostFunction, auth: xdr.SorobanAuthorizationEntry[]) => {
  const result = await client.submitSorobanTransaction({ func: func.toXDR("base64"), auth: auth.map((a) => a.toXDR("base64")) });
  console.log("  channels:", result.status, result.hash);
  if (!result.hash) throw new Error(`Channels returned no transaction hash (status ${result.status})`);
  return { hash: result.hash };
};

const master = Keypair.random();
console.log("new master:", master.publicKey());
await fundWithFriendbot(master.publicKey());
const base = createScenarioContext({
  ...process.env,
  MASTER_SECRET: master.secret(),
  MASTER_PUBLIC: master.publicKey(),
  SMART_ACCOUNT_ID: factory, // placeholder until the account exists
});
// The master (an account that exists anyway) is the simulation source, so no other account is involved.
const ctx = { ...base, relay, simulationSource: master.publicKey() };

const predicted = await factoryAccountAddress(ctx, factory, master.publicKey(), 0);
console.log("predicted account:", predicted);

console.log("1. create() signed like a wallet would (a transaction the master is the source of), paid by Channels");
const relayTransaction = async (signedXdr: string) => {
  const result = await client.submitTransaction({ xdr: signedXdr });
  console.log("  channels:", result.status, result.hash);
  if (!result.hash) throw new Error(`Channels returned no transaction hash (status ${result.status})`);
  return { hash: result.hash };
};
assert.deepEqual(await findFactoryAccounts(ctx, factory, master.publicKey()), [], "the master should have no account yet");
const created = await createAccountViaFactory({
  ctx: { ...ctx, relayTransaction },
  factoryId: factory,
  master: master.publicKey(),
  index: 0,
  signTransaction: async (unsignedXdr) => {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET) as Transaction;
    tx.sign(master);
    return tx.toXDR();
  },
});
assert.ok(created.ok, created.ok ? "" : `${created.stage}: ${created.error}\n${created.detail ?? ""}`);
assert.equal(created.returnValue, predicted, "the factory returned a different address than it predicted");
console.log("  created", created.returnValue);
assert.deepEqual(await findFactoryAccounts(ctx, factory, master.publicKey()), [{ index: 0, smartAccountId: predicted }]);
console.log("  found again from the master alone");

console.log("2. the account's master is the new key");
const masterBytes = (await read(ctx, predicted, "master")) as Uint8Array;
assert.equal(Buffer.from(masterBytes).toString("hex"), Buffer.from(master.rawPublicKey()).toString("hex"));
console.log("  ok, version", await read(ctx, predicted, "version"));

console.log("3. a policy change on the new account through Channels");
const accountCtx = { ...ctx, smartAccountId: predicted };
const record = await runPolicyOp(accountCtx, {
  op: "allow",
  signer: base.delegate.publicKey(),
  contract: base.simId,
  function: "claim",
  constraints: [{ kind: "self" }],
  expiry: { kind: "minutes", minutes: 30 },
});
assert.equal(record.outcome, "success", `policy change failed: ${record.error ?? JSON.stringify(record)}`);
console.log("  ok:", record.txHash);

console.log("\nAll checks passed: no server-held key paid for or submitted any of it.");
