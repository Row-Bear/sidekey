// End-to-end check of the signature broker over HTTP, on testnet. This script plays the browser:
// it waits for the server to ask for a signature, answers (wrongly first), and checks that jobs
// pause, resume, cancel and refuse replays.
//
// Needs the dev server running (`npm run web`) and an account that has been through `npm run poc -- --fresh`.
// Run: npx tsx spikes/broker/run.ts
import "dotenv/config";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import { type CallRecord, type PendingSignature, sep53Digest } from "@poc/core";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const master = Keypair.fromSecret(process.env.MASTER_SECRET!);
const delegate = Keypair.fromSecret(process.env.DELEGATE_SECRET!);
const SIM = process.env.YIELD_SIM_CONTRACT_ID!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface State {
  run: { busy: boolean; lastError: string | null };
  pendingSignatures: PendingSignature[];
  calls: CallRecord[];
  results: Record<string, { outcome: string; asExpected: boolean; txHash?: string }>;
}

async function api<T = unknown>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const state = async () => (await api<State>("/api/state")).body;
const b64 = (sig: Uint8Array) => Buffer.from(sig).toString("base64");

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, seconds = 90): Promise<T> {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await probe();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const pendingSignature = () => waitFor("a pending signature", async () => (await state()).pendingSignatures[0]);
const idle = () => waitFor("the job to finish", async () => !(await state()).run.busy);

async function start(body: unknown) {
  const res = await api("/api/run", body);
  assert.equal(res.status, 202, JSON.stringify(res.body));
}

const expiryOp = (minutes: number) => ({
  op: "set-expiry",
  signer: Buffer.from(delegate.rawPublicKey()).toString("hex"),
  expiry: { kind: "minutes", minutes },
});

await waitFor("an idle server", async () => !(await state()).run.busy);

// 1. A master-only policy edit pauses for a browser signature, rejects a bad one, then completes.
console.log("1. policy edit via browser: pause, wrong signer refused, right signer accepted");
const before = (await state()).calls.length;
await start({ action: "policy", policy: expiryOp(30), via: "browser" });
const pending = await pendingSignature();
assert.equal(pending.signer.address, master.publicKey());
assert.match(pending.summary.join("\n"), /^set_expiry\(/, `summary: ${pending.summary}`);
assert.equal((await state()).run.busy, true, "the job must be waiting");
assert.equal((await state()).calls.length, before, "nothing finishes before a signature");
console.log("   server is asking:", pending.summary[0].slice(0, 70) + "…");

const payload = Buffer.from(pending.payloadHex, "hex");
const wrong = await api<{ error: string }>("/api/signature", { id: pending.id, response: { kind: "payload", signature: b64(delegate.sign(payload)) } });
assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
console.log("   wrong signer's signature refused:", wrong.body.error);
assert.equal((await state()).pendingSignatures.length, 1, "request stays pending after a bad answer");

const right = await api("/api/signature", { id: pending.id, response: { kind: "payload", signature: b64(master.sign(payload)) } });
assert.equal(right.status, 200);
await idle();
let record = (await state()).calls[0];
assert.equal(record.outcome, "success", JSON.stringify(record));
console.log("   completed:", record.explorerUrl);

const replay = await api("/api/signature", { id: pending.id, response: { kind: "payload", signature: b64(master.sign(payload)) } });
assert.equal(replay.status, 404);
console.log("   replaying the answer refused (404)");

// 2. The SEP-53 message kind (a wallet that only signs messages).
console.log("2. same, answered with a SEP-53 message signature");
await start({ action: "policy", policy: expiryOp(31), via: "browser" });
const second = await pendingSignature();
const message = await api("/api/signature", {
  id: second.id,
  response: { kind: "message", signature: Buffer.from(master.sign(sep53Digest(second.message))).toString("hex") },
});
assert.equal(message.status, 200, JSON.stringify(message.body));
await idle();
record = (await state()).calls[0];
assert.equal(record.outcome, "success", JSON.stringify(record));
console.log("   completed:", record.explorerUrl);

// 3. Cancelling fails the job cleanly.
console.log("3. cancel");
await start({ action: "policy", policy: expiryOp(32), via: "browser" });
const third = await pendingSignature();
assert.equal((await api("/api/signature", { id: third.id, cancel: true, reason: "Not now" })).status, 200);
await idle();
record = (await state()).calls[0];
assert.equal(record.outcome, "failure");
assert.match(record.error ?? "", /Not now/);
assert.equal((await state()).pendingSignatures.length, 0);
console.log("   job failed with:", record.error);

// 4. A scenario step pauses for the browser and continues (step 1 sets the delegate's policy).
console.log("4. scenario step 1 via browser");
await start({ action: "steps", from: 1, to: 1, via: "browser" });
const step = await pendingSignature();
assert.match(step.summary[0], /^set_signer\(/);
await api("/api/signature", { id: step.id, response: { kind: "payload", signature: b64(master.sign(Buffer.from(step.payloadHex, "hex"))) } });
await idle();
const result = (await state()).results["1"];
assert.equal(result.outcome, "success");
assert.equal(result.asExpected, true);
console.log("   step 1 completed:", `https://stellar.expert/explorer/testnet/tx/${result.txHash}`);

// 5. Malformed answers are refused with a clear status.
console.log("5. malformed answers");
assert.equal((await api("/api/signature", { id: "nope", response: { kind: "payload", signature: "x" } })).status, 404);
assert.equal((await api("/api/signature", { id: "x" })).status, 400);
assert.equal((await api("/api/signature", { response: {} })).status, 400);
console.log("   unknown id 404; malformed bodies 400");

console.log("\nALL BROKER CHECKS PASSED");
