import { createHash, createPublicKey, verify } from "node:crypto";

// WebAuthn (passkey) assertions as the smart account verifies them. `checkAssertion` applies the same
// checks as the contract, so the server can refuse a bad answer early (and let the person retry)
// instead of finding out from an on-chain rejection.

/** Order of the P-256 curve; Soroban only accepts signatures whose `s` is at most half of it. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const HALF_ORDER = P256_ORDER >> 1n;

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const MAX_CLIENT_DATA = 512;
const MAX_AUTHENTICATOR_DATA = 512;
const CLIENT_DATA_HEAD = '{"type":"webauthn.get","challenge":"';

/** SPKI header for a P-256 public key; the 65-byte uncompressed point follows it. */
const P256_SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

export const rpIdHash = (rpId: string): Buffer => createHash("sha256").update(rpId, "utf8").digest();

/** base64url without padding, the form WebAuthn puts the challenge in. */
export const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** The 65-byte uncompressed point from the SPKI that `getPublicKey()` returns. */
export function publicKeyFromSpki(spki: Uint8Array): Buffer {
  const bytes = Buffer.from(spki);
  if (bytes.length !== 91 || !bytes.subarray(0, 26).equals(P256_SPKI_PREFIX) || bytes[26] !== 0x04) {
    throw new Error("Not an uncompressed P-256 public key (the passkey must use ES256)");
  }
  return bytes.subarray(26);
}

const toBig = (bytes: Uint8Array): bigint => BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));

/** Reads one DER INTEGER at `at`; returns its unsigned bytes and the offset after it. */
function derInteger(der: Uint8Array, at: number): { value: Uint8Array; next: number } {
  if (der[at] !== 0x02) throw new Error("Malformed signature (expected an INTEGER)");
  const length = der[at + 1];
  if (length === undefined || length > 33 || at + 2 + length > der.length) throw new Error("Malformed signature (bad INTEGER length)");
  return { value: der.subarray(at + 2, at + 2 + length), next: at + 2 + length };
}

/**
 * Converts the DER signature a WebAuthn authenticator returns into the 64-byte `r || s` form the host
 * expects, with `s` normalized to the low half of the curve order (authenticators return either).
 */
export function derToCompactLowS(der: Uint8Array): Buffer {
  if (der[0] !== 0x30 || der[1] === undefined || der[1] + 2 !== der.length) throw new Error("Malformed signature (expected a DER sequence)");
  const r = derInteger(der, 2);
  const s = derInteger(der, r.next);
  if (s.next !== der.length) throw new Error("Malformed signature (trailing bytes)");
  const rValue = toBig(r.value);
  let sValue = toBig(s.value);
  if (rValue === 0n || rValue >= P256_ORDER || sValue === 0n || sValue >= P256_ORDER) throw new Error("Malformed signature (out of range)");
  if (sValue > HALF_ORDER) sValue = P256_ORDER - sValue;
  const out = Buffer.alloc(64);
  out.write(rValue.toString(16).padStart(64, "0"), 0, "hex");
  out.write(sValue.toString(16).padStart(64, "0"), 32, "hex");
  return out;
}

export interface Assertion {
  authenticatorData: Uint8Array;
  clientDataJson: Uint8Array;
}

/** The contract's assertion checks, in the same order and with the same meaning. Throws a readable error. */
export function checkAssertion(expected: { rpIdHash: Uint8Array; payload: Uint8Array }, assertion: Assertion): void {
  const auth = Buffer.from(assertion.authenticatorData);
  if (auth.length < 37 || auth.length > MAX_AUTHENTICATOR_DATA) throw new Error("The authenticator data is malformed");
  if (!auth.subarray(0, 32).equals(Buffer.from(expected.rpIdHash))) {
    throw new Error("The passkey answered for a different site (relying party) than the one it was registered for");
  }
  if (!(auth[32] & FLAG_USER_PRESENT)) throw new Error("The passkey did not report user presence");
  if (!(auth[32] & FLAG_USER_VERIFIED)) throw new Error("The passkey did not verify the user (user verification is required)");

  const json = Buffer.from(assertion.clientDataJson).toString("utf8");
  const challenge = base64url(expected.payload);
  const head = CLIENT_DATA_HEAD.length;
  if (assertion.clientDataJson.length > MAX_CLIENT_DATA || !json.startsWith(CLIENT_DATA_HEAD) || json.length < head + challenge.length + 1) {
    throw new Error("The client data is not a WebAuthn assertion for this request");
  }
  if (json.slice(head, head + challenge.length) !== challenge || json[head + challenge.length] !== '"') {
    throw new Error("The passkey signed a different request (the challenge does not match)");
  }
}

/** Verifies a compact low-S ES256 signature over `authenticatorData || sha256(clientDataJSON)`. */
export function verifyPasskeySignature(publicKey: Uint8Array, assertion: Assertion, signature: Uint8Array): boolean {
  if (signature.length !== 64 || toBig(signature.subarray(32)) > HALF_ORDER) return false;
  const signed = Buffer.concat([Buffer.from(assertion.authenticatorData), createHash("sha256").update(assertion.clientDataJson).digest()]);
  try {
    const key = createPublicKey({ key: Buffer.concat([P256_SPKI_PREFIX, Buffer.from(publicKey)]), format: "der", type: "spki" });
    return verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature));
  } catch {
    return false;
  }
}
