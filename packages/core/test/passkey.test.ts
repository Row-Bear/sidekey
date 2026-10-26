import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { scValToNative } from "@stellar/stellar-sdk";
import {
  base64url,
  checkAssertion,
  derToCompactLowS,
  publicKeyFromSpki,
  rpIdHash,
  verifyPasskeySignature,
} from "../src/passkey.ts";
import { parseSignerPolicy, passkeySignatureScVal, signerIdScVal } from "../src/policy.ts";

// Real output of a Chrome virtual authenticator (ES256, user verification): 32 assertions whose
// challenge is the payload being signed.
const fixture = JSON.parse(
  readFileSync(new URL("../../../contracts/smart-account/test-fixtures/webauthn-assertions.json", import.meta.url), "utf8"),
) as { spki: string; assertions: { challenge: string; authenticatorData: string; clientDataJSON: string; signature: string }[] };

const publicKey = publicKeyFromSpki(Buffer.from(fixture.spki, "base64"));
const rp = rpIdHash("localhost");
const real = fixture.assertions.map((a) => ({
  payload: Buffer.from(a.challenge, "base64"),
  assertion: { authenticatorData: Buffer.from(a.authenticatorData, "base64"), clientDataJson: Buffer.from(a.clientDataJSON, "base64") },
  der: Buffer.from(a.signature, "base64"),
}));
const HALF = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8n;
const sValue = (compact: Uint8Array) => BigInt("0x" + Buffer.from(compact.subarray(32)).toString("hex"));
const withJson = (a: (typeof real)[number], edit: (json: string) => string) => ({
  ...a.assertion,
  clientDataJson: Buffer.from(edit(a.assertion.clientDataJson.toString("utf8"))),
});

describe("public key and signature handling", () => {
  it("extracts the 65-byte point from the SPKI and refuses anything else", () => {
    assert.equal(publicKey.length, 65);
    assert.equal(publicKey[0], 0x04);
    assert.throws(() => publicKeyFromSpki(Buffer.alloc(91)), /ES256/);
    assert.throws(() => publicKeyFromSpki(Buffer.from(fixture.spki, "base64").subarray(1)), /ES256/);
  });

  it("converts every real signature to low-S compact form that verifies, whatever its original s", () => {
    let wasHigh = 0;
    for (const a of real) {
      const compact = derToCompactLowS(a.der);
      assert.equal(compact.length, 64);
      assert.ok(sValue(compact) <= HALF);
      assert.equal(verifyPasskeySignature(publicKey, a.assertion, compact), true);
      // The DER's own s, to count how many needed normalizing.
      const rLen = a.der[3];
      const sLen = a.der[5 + rLen];
      if (BigInt("0x" + a.der.subarray(6 + rLen, 6 + rLen + sLen).toString("hex")) > HALF) wasHigh++;
    }
    assert.ok(wasHigh > 0 && wasHigh < real.length, `expected a mix of high and low s, got ${wasHigh} of ${real.length} high`);
  });

  it("refuses a high-S signature even though it is valid ECDSA", () => {
    const compact = Buffer.from(derToCompactLowS(real[0].der));
    const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const mirrored = Buffer.concat([compact.subarray(0, 32), Buffer.from((order - sValue(compact)).toString(16).padStart(64, "0"), "hex")]);
    assert.equal(verifyPasskeySignature(publicKey, real[0].assertion, mirrored), false);
  });

  it("rejects malformed DER", () => {
    const der = real[0].der;
    assert.throws(() => derToCompactLowS(der.subarray(0, der.length - 1)), /Malformed/);
    assert.throws(() => derToCompactLowS(Buffer.concat([der, Buffer.from([0])])), /Malformed/);
    assert.throws(() => derToCompactLowS(Buffer.from([0x31, ...der.subarray(1)])), /Malformed/);
    assert.throws(() => derToCompactLowS(Buffer.from("3006020100020100", "hex")), /out of range/); // r = s = 0
    assert.throws(() => derToCompactLowS(Buffer.alloc(0)), /Malformed/);
  });

  it("does not verify tampered data, a wrong key or a wrong length", () => {
    const compact = derToCompactLowS(real[0].der);
    assert.equal(verifyPasskeySignature(publicKey, withJson(real[0], (t) => t.replace("localhost", "localhosx")), compact), false);
    assert.equal(verifyPasskeySignature(publicKey, real[1].assertion, compact), false);
    const other = Buffer.from(publicKey);
    other[40] ^= 1;
    assert.equal(verifyPasskeySignature(other, real[0].assertion, compact), false);
    assert.equal(verifyPasskeySignature(publicKey, real[0].assertion, compact.subarray(1)), false);
  });
});

describe("checkAssertion (the contract's checks)", () => {
  const ok = real[0];
  const check = (assertion = ok.assertion, expectedRp: Uint8Array = rp, payload: Uint8Array = ok.payload) =>
    checkAssertion({ rpIdHash: expectedRp, payload }, assertion);

  it("accepts all real assertions", () => {
    for (const a of real) checkAssertion({ rpIdHash: rp, payload: a.payload }, a.assertion);
  });

  it("refuses a different relying party, payload, and missing flags", () => {
    assert.throws(() => check(ok.assertion, rpIdHash("example.com")), /different site/);
    assert.throws(() => check(ok.assertion, rp, real[1].payload), /challenge does not match/);
    const flags = (mask: number) => {
      const data = Buffer.from(ok.assertion.authenticatorData);
      data[32] &= ~mask;
      return { ...ok.assertion, authenticatorData: data };
    };
    assert.throws(() => check(flags(0x01)), /user presence/);
    assert.throws(() => check(flags(0x04)), /verify the user/);
    assert.throws(() => check({ ...ok.assertion, authenticatorData: ok.assertion.authenticatorData.subarray(0, 36) }), /malformed/);
  });

  it("requires the challenge in its fixed place, exact and closed", () => {
    const challenge = base64url(ok.payload);
    const body = (text: string) => ({ ...ok.assertion, clientDataJson: Buffer.from(text) });
    assert.throws(() => check(body(`{"challenge":"${challenge}","type":"webauthn.get"}`)), /not a WebAuthn assertion/);
    assert.throws(() => check(body(`{"type":"webauthn.get","challenge":"${"A".repeat(43)}","x":"${challenge}"}`)), /challenge does not match/);
    assert.throws(() => check(body(`{"type":"webauthn.get","challenge":"${challenge}A","origin":"x"}`)), /challenge does not match/);
    assert.throws(() => check(withJson(ok, (t) => t.replace("webauthn.get", "webauthn.cret"))), /not a WebAuthn assertion/);
    assert.throws(() => check(withJson(ok, (t) => t + " ".repeat(600))), /not a WebAuthn assertion/);
    assert.throws(() => check(body("")), /not a WebAuthn assertion/);
  });
});

describe("ScVal encoders", () => {
  it("chooses the signer variant by key length", () => {
    assert.equal((scValToNative(signerIdScVal(Buffer.alloc(32, 1))) as [string])[0], "Ed25519");
    assert.equal((scValToNative(signerIdScVal(publicKey)) as [string])[0], "Passkey");
    assert.throws(() => signerIdScVal(Buffer.alloc(33)), /32 bytes/);
  });

  it("encodes a passkey signature with the contract's field names", () => {
    const [kind, body] = scValToNative(
      passkeySignatureScVal({
        publicKey,
        authenticatorData: real[0].assertion.authenticatorData,
        clientDataJson: real[0].assertion.clientDataJson,
        signature: derToCompactLowS(real[0].der),
      }),
    ) as [string, Record<string, Uint8Array>];
    assert.equal(kind, "Passkey");
    assert.deepEqual(Object.keys(body), ["authenticator_data", "client_data_json", "public_key", "sig"]);
    assert.equal(body.sig.length, 64);
    assert.equal(body.public_key.length, 65);
  });

  it("reads the relying party hash from a policy", () => {
    const view = parseSignerPolicy({ valid_until_ledger: 7, rp_id_hash: rp, rules: [] });
    assert.equal(view.rpIdHashHex, rp.toString("hex"));
    assert.equal(parseSignerPolicy({ rules: [] }).rpIdHashHex, null);
  });
});

describe("base64url", () => {
  it("matches Node's encoding: URL-safe characters and no padding", () => {
    for (const bytes of [new Uint8Array([251, 255, 254]), new Uint8Array([0]), new Uint8Array(32).fill(250), new Uint8Array([])]) {
      assert.equal(base64url(bytes), Buffer.from(bytes).toString("base64url"));
    }
  });
});
