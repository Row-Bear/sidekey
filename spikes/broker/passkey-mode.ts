// End-to-end passkey delegate over HTTP on testnet. This script plays the authenticator: it holds a P-256
// key the server never sees, registers it as the delegate, and answers every delegate signature request
// with a WebAuthn assertion (DER signature, high-S or low-S at random, as real devices produce) while the
// full demo and the expiry demo run. It also checks that a wrong assertion is refused and can be retried.
// Needs the dev server running (`npm run web`).
//
// Run: npx tsx spikes/broker/passkey-mode.ts
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { PendingSignature, StepResult } from "@poc/core";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const RP_ID = new URL(BASE).hostname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();
const b64url = (data: Buffer) => data.toString("base64url");

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const spki = publicKey.export({ format: "der", type: "spki" });
const publicKeyHex = spki.subarray(spki.length - 65).toString("hex"); // uncompressed point
const credentialId = b64url(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));

/** What `navigator.credentials.get` returns for this challenge. */
function assertion(payloadHex: string, { rpId = RP_ID, flags = 0x05, challenge = payloadHex } = {}) {
  const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
  const clientDataJson = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: b64url(Buffer.from(challenge, "hex")), origin: BASE, crossOrigin: false }),
  );
  const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJson)]), privateKey); // DER
  return {
    kind: "passkey",
    authenticatorData: authenticatorData.toString("base64"),
    clientDataJson: clientDataJson.toString("base64"),
    signature: signature.toString("base64"),
  };
}

interface State {
  delegate: string;
  accounts: { smartAccount: string; delegate: string };
  run: { busy: boolean; lastError: string | null };
  pendingSignatures: PendingSignature[];
  results: Record<string, StepResult>;
}

async function api<T = unknown>(path: string, body?: unknown) {
  // The dev server can drop an idle keep-alive connection; a reset before any response is safe to retry here.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as T };
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(300);
    }
  }
}
const state = async () => (await api<State>("/api/state")).body;

const prompts: string[] = [];
let checkedBadAnswers = false;

/** Plays the authenticator: answers every passkey request until the job is idle. */
async function runJob(body: unknown, label: string) {
  const started = await api("/api/run", body);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 600; i++) {
    const s = await state();
    const [pending] = s.pendingSignatures;
    if (pending) {
      assert.equal(pending.kind, "auth-entry");
      assert.equal(pending.signer.kind, "passkey", "only the passkey may be asked");
      assert.equal(pending.signer.id, publicKeyHex);
      if (!checkedBadAnswers) {
        checkedBadAnswers = true;
        const bad: [string, unknown][] = [
          ["a different challenge", assertion(pending.payloadHex, { challenge: "00".repeat(32) })],
          ["another relying party", assertion(pending.payloadHex, { rpId: "example.com" })],
          ["user verification missing", assertion(pending.payloadHex, { flags: 0x01 })],
          ["a payload answer for a passkey", { kind: "payload", signature: "AAAA" }],
        ];
        for (const [what, answer] of bad) {
          const r = await api<{ error?: string }>("/api/signature", { id: pending.id, response: answer });
          assert.ok(r.status === 422 || r.status === 400, `${what} must be refused, got ${r.status}`);
          console.log(`   refused ${what}: ${r.body.error?.slice(0, 70)}`);
        }
        assert.equal((await state()).pendingSignatures[0]?.id, pending.id, "the request must stay pending after bad answers");
      }
      const r = await api("/api/signature", { id: pending.id, response: assertion(pending.payloadHex) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      prompts.push(pending.summary[0].slice(0, 40));
    } else if (!s.run.busy) {
      if (s.run.lastError) throw new Error(`${label}: ${s.run.lastError}`);
      return s;
    }
    await sleep(500);
  }
  throw new Error(`${label}: timed out`);
}

console.log("passkey:", publicKeyHex.slice(2, 10) + "…", "rp id:", RP_ID);
const registered = await api("/api/passkey", { action: "register", credentialId, publicKeyHex, rpId: RP_ID });
assert.equal(registered.status, 200, JSON.stringify(registered.body));
const wrongSite = await api("/api/passkey", { action: "register", credentialId, publicKeyHex, rpId: "example.com" });
assert.equal(wrongSite.status >= 400, true, "a passkey for another site must be refused");

let s = await runJob({ action: "full" }, "full demo");
assert.equal(s.delegate, "passkey");
for (let n = 1; n <= 7; n++) {
  const r = s.results[String(n)];
  console.log(`step ${n}: ${r.outcome}${r.asExpected ? "" : " (UNEXPECTED)"}${r.txHash ? "  " + r.txHash.slice(0, 10) + "…" : ""}`);
  assert.equal(r.asExpected, true, `step ${n}: ${r.error}`);
}
assert.match(s.results["6"].error ?? "", /NotAllowed/, "the passkey's withdraw must be refused by the policy");
assert.equal(prompts.length, 2, "steps 5 and 6 are the passkey's");

console.log("\nexpiry demo (about a minute)");
prompts.length = 0;
s = await runJob({ action: "steps", from: 8, to: 9 }, "expiry demo");
for (const n of [8, 9]) assert.equal(s.results[String(n)].asExpected, true, `step ${n}: ${s.results[String(n)].error}`);
assert.match(s.results["9"].error ?? "", /SignerExpired/, "the expired passkey must be refused");
console.log("   step 9 refused:", s.results["9"].error?.slice(-40));

// Leave the dashboard on the demo key.
await api("/api/passkey", { action: "select", delegate: "key" });
console.log("\nPASSKEY DELEGATE DEMO PASSED");
