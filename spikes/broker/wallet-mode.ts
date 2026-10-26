// End-to-end wallet mode over HTTP on testnet. This script plays the connected wallet: it holds a key
// the server never sees, funds it with Friendbot, asks the server for a smart account owned by it, and
// then answers every signature request (SEP-53 messages for auth entries, whole transactions) while the
// demo runs. Needs the dev server running (`npm run web`).
//
// Run: npx tsx spikes/broker/wallet-mode.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, Networks, type Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { CallRecord, PendingSignature, StepResult } from "@poc/core";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const wallet = Keypair.random(); // lives only in this script, like a wallet extension's key
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface State {
  mode: string;
  wallet: { address: string; smartAccountId: string } | null;
  accounts: { master: string; smartAccount: string };
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
/** Plays the wallet: answers whatever the server is waiting for, until the job is idle. */
async function runJob(body: unknown, label: string) {
  const started = await api("/api/run", body);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 600; i++) {
    const s = await state();
    const [pending] = s.pendingSignatures;
    if (pending) {
      let answer: unknown;
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
assert.equal(prompts.length, 5);
console.log("   second full run passed with a new smart account:", s.accounts.smartAccount);

console.log("\nWALLET MODE DEMO PASSED");
