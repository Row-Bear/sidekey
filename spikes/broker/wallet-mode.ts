// End-to-end wallet mode over HTTP on testnet. This script plays the connected wallet: it holds a key
// the server never sees, funds it with Friendbot, asks the server for a smart account owned by it, and
// then answers every signature request (SEP-53 messages for auth entries, whole transactions) while the
// demo runs. Needs the dev server running (`npm run web`).
//
// Run: npx tsx spikes/broker/wallet-mode.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { Keypair, Networks, type Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { CallRecord, PendingSignature, StepResult } from "@poc/core";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const wallet = Keypair.random(); // lives only in this script, like a wallet extension's key
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface State {
  mode: string;
  wallet: { address: string; smartAccountId: string } | null;
  accounts: { master: string; smartAccount: string; simulator: string };
  knownAccounts: { address: string; smartAccountId: string }[];
  run: { busy: boolean; lastError: string | null; log: string[] };
  pendingSignatures: PendingSignature[];
  results: Record<string, StepResult>;
  calls: CallRecord[];
}

async function api<T = unknown>(path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}
const state = async () => (await api<State>("/api/state")).body;

const prompts: string[] = [];
/** When set, the wallet refuses transaction prompts (the user closes the popup). */
let declineTransactions = false;
/** Plays the wallet: answers whatever the server is waiting for, until the job is idle. */
async function runJob(body: unknown, label: string) {
  const started = await api("/api/run", body);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 600; i++) {
    const s = await state();
    const [pending] = s.pendingSignatures;
    if (pending) {
      let answer: unknown;
      if (pending.kind === "transaction" && declineTransactions) {
        const r = await api("/api/signature", { id: pending.id, cancel: true });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        prompts.push(`declined         ${pending.summary[0].slice(0, 60)}`);
        await sleep(500);
        continue;
      }
      if (pending.kind === "transaction") {
        const tx = TransactionBuilder.fromXDR(pending.transactionXdr, Networks.TESTNET) as Transaction;
        assert.equal(tx.source, wallet.publicKey(), "the wallet must be the transaction source");
        tx.sign(wallet);
        answer = { kind: "transaction", signedXdr: tx.toXDR() };
        prompts.push(`signTransaction  ${pending.summary[0].slice(0, 60)}`);
      } else {
        assert.equal(pending.signer.address, wallet.publicKey(), "only the wallet's key may be asked");
        // What an xBull-like wallet does: SEP-53 over the message it is shown.
        const digest = createHash("sha256").update(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(pending.message)])).digest();
        answer = { kind: "message", signature: Buffer.from(wallet.sign(digest)).toString("base64") };
        prompts.push(`signMessage      ${pending.summary[0].slice(0, 60)}`);
      }
      const r = await api("/api/signature", { id: pending.id, response: answer });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    } else if (!s.run.busy) {
      if (s.run.lastError) throw new Error(`${label}: ${s.run.lastError}`);
      return s;
    }
    await sleep(500);
  }
  throw new Error(`${label}: timed out`);
}

console.log("wallet:", wallet.publicKey());
await runJob({ action: "wallet-fund", address: wallet.publicKey() }, "fund");
const status = await api<{ exists: boolean; stroops: string }>(`/api/wallet-status?address=${wallet.publicKey()}`);
assert.equal(status.body.exists, true);
console.log("funded:", Number(BigInt(status.body.stroops) / 10_000_000n), "XLM");

let s = await runJob({ action: "wallet-account", address: wallet.publicKey() }, "create account");
assert.equal(s.mode, "wallet");
assert.equal(s.accounts.master, wallet.publicKey());
assert.equal(s.wallet?.address, wallet.publicKey());
console.log("smart account for the wallet:", s.accounts.smartAccount);
const firstAccount = s.accounts.smartAccount;
// Creating the account asks the wallet to record it on its own account (a data entry).
assert.deepEqual(prompts.map((p) => p.split(/\s+/)[0]), ["signTransaction"]);
assert.match(prompts[0], /Record smart account/);
const recordedOf = async () => (await api<{ accounts: { index: number; smartAccountId: string }[] }>(`/api/wallet-accounts?address=${wallet.publicKey()}`)).body.accounts;
assert.deepEqual(await recordedOf(), [{ index: 1, smartAccountId: firstAccount }]);
console.log("   recorded on the wallet's account as smart_account_1");
prompts.length = 0;

for (const [from, to] of [[1, 7]] as const) {
  s = await runJob({ action: "steps", from, to }, `steps ${from}-${to}`);
}
for (let n = 1; n <= 7; n++) {
  const r = s.results[String(n)];
  console.log(`step ${n}: ${r.outcome}${r.asExpected ? "" : " (UNEXPECTED)"}${r.txHash ? "  " + r.txHash.slice(0, 10) + "…" : ""}`);
  assert.equal(r.asExpected, true, `step ${n}: ${r.error}`);
}

console.log(`\nwallet prompts (${prompts.length}):`);
prompts.forEach((p) => console.log("  " + p));
// Steps 1, 3, 4 and 7 are master auth entries (messages); step 2 is a whole transaction.
assert.deepEqual(prompts.map((p) => p.split(/\s+/)[0]), ["signMessage", "signTransaction", "signMessage", "signMessage", "signMessage"]);
// The funds can be moved back to the wallet (the call builder's "send XLM to the master"), so the same
// wallet can run the whole demo again with a fresh smart account.
console.log("\nreturning the funds to the wallet, then running the demo again");
const native = (await api<{ nativeToken: string }>("/api/signers")).body.nativeToken;
const balanceOf = async () => BigInt((await api<{ stroops: string }>(`/api/wallet-status?address=${wallet.publicKey()}`)).body.stroops);
const walletBefore = await balanceOf();
const smartBalance = 95_000_000_000n; // the 9,500 XLM the demo moved in and out
s = await runJob(
  { action: "call", call: { contract: native, function: "transfer", args: [s.accounts.smartAccount, wallet.publicKey(), smartBalance.toString()], signer: "master" } },
  "return funds",
);
assert.equal(s.calls[0].outcome, "success", JSON.stringify(s.calls[0]));
assert.equal((await balanceOf()) - walletBefore, smartBalance);
console.log("   wallet balance +9,500 XLM");

prompts.length = 0;
s = await runJob({ action: "full" }, "second full run");
for (let n = 1; n <= 7; n++) assert.equal(s.results[String(n)].asExpected, true, `second run, step ${n}: ${s.results[String(n)].error}`);
assert.deepEqual(prompts.map((p) => p.split(/\s+/)[0]), ["signTransaction", "signMessage", "signTransaction", "signMessage", "signMessage", "signMessage"]);
console.log("   second full run passed with a new smart account:", s.accounts.smartAccount);

const secondAccount = s.accounts.smartAccount;
assert.notEqual(secondAccount, firstAccount);
assert.deepEqual(await recordedOf(), [{ index: 1, smartAccountId: firstAccount }, { index: 2, smartAccountId: secondAccount }]);

// If the wallet refuses the record prompt, the account is still created; recording can be done later.
console.log("\ncreating an account while the wallet declines to record it");
prompts.length = 0;
declineTransactions = true;
s = await runJob({ action: "wallet-account", address: wallet.publicKey() }, "create account, record declined");
declineTransactions = false;
const thirdAccount = s.accounts.smartAccount;
assert.deepEqual(prompts.map((p) => p.split(/\s+/)[0]), ["declined"]);
assert.ok(s.run.log.some((l) => l.includes("Not recorded")), "the declined record must be logged");
assert.equal((await recordedOf()).length, 2, "nothing is recorded when declined");
prompts.length = 0;
s = await runJob({ action: "record-account", address: wallet.publicKey() }, "record later");
assert.deepEqual(prompts.map((p) => p.split(/\s+/)[0]), ["signTransaction"]);
assert.deepEqual((await recordedOf()).map((r) => r.smartAccountId), [firstAccount, secondAccount, thirdAccount]);
prompts.length = 0;
s = await runJob({ action: "record-account", address: wallet.publicKey() }, "record again");
assert.equal(prompts.length, 0, "an account that is already recorded asks for nothing");
assert.ok(s.run.log.some((l) => l.includes("Already recorded")));
console.log("   recorded later as smart_account_3; recording again asks nothing");

// Loading an existing smart account instead of creating a new one.
console.log("\nloading the first smart account again");
const load = (address: string, smartAccountId: string) => api<{ error?: string }>("/api/wallet-load", { address, smartAccountId });
const loaded = await load(wallet.publicKey(), firstAccount);
assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
s = await state();
assert.equal(s.accounts.smartAccount, firstAccount, "the loaded account must become the current one");
assert.equal(s.mode, "wallet");
assert.deepEqual(Object.keys(s.results), [], "results belong to the account they ran on");
const mine = s.knownAccounts.filter((a) => a.address === wallet.publicKey()).map((a) => a.smartAccountId);
assert.deepEqual(mine, [firstAccount, thirdAccount, secondAccount], "known accounts list the loaded one first, once each");
console.log("   loaded; known accounts:", mine.length);

const demoOwned = parse(readFileSync(new URL("../../.env", import.meta.url))).SMART_ACCOUNT_ID;
const refusals: [string, string, string, RegExp][] = [
  ["an account owned by someone else", wallet.publicKey(), demoOwned, /belongs to/],
  ["the right account for the wrong wallet", Keypair.random().publicKey(), firstAccount, /belongs to/],
  ["a contract that is not a smart account", wallet.publicKey(), s.accounts.simulator, /not a smart account/],
  ["something that is not a contract id", wallet.publicKey(), "GABC", /not a contract id/],
];
for (const [what, address, id, pattern] of refusals) {
  const r = await load(address, id);
  assert.ok(r.status >= 400, `${what} must be refused`);
  assert.match(r.body.error ?? "", pattern, what);
  console.log(`   refused ${what}`);
}
assert.equal((await state()).accounts.smartAccount, firstAccount, "refused loads must not change the account");

// The loaded account is live: the wallet can act on it as master.
prompts.length = 0;
s = await runJob({ action: "steps", from: 1, to: 1 }, "step 1 on the loaded account");
assert.equal(s.results["1"].asExpected, true, s.results["1"].error);
assert.equal(prompts.length, 1);
console.log("   step 1 ran on the loaded account with one wallet prompt");

console.log("\nWALLET MODE DEMO PASSED");
