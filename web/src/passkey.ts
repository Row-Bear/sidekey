import type { PasskeyDelegate, PendingSignature, SignatureResponse } from "@poc/core";
import type { BrowserSigner } from "./signing";

// WebAuthn in the browser: creating a passkey to act as the delegate, and signing with it. The server
// does the conversion and checks (DER to low-S, relying party, challenge) so a bad answer can be retried.

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(text.match(/../g) ?? [], (h) => parseInt(h, 16));
const toBase64 = (buffer: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buffer)));
const toBase64Url = (buffer: ArrayBuffer): string => toBase64(buffer).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const passkeysSupported = (): boolean =>
  typeof window !== "undefined" && window.isSecureContext && typeof PublicKeyCredential !== "undefined" && !!navigator.credentials;

/** SPKI header of a P-256 key; the 65-byte uncompressed point follows it. */
const P256_SPKI_PREFIX = "3059301306072a8648ce3d020106082a8648ce3d030107034200";

/** Creates a passkey for this site and returns what the account needs to register it. */
export async function createPasskey(): Promise<PasskeyDelegate> {
  if (!passkeysSupported()) throw new Error("Passkeys need a secure context (https or localhost) and a browser that supports WebAuthn");
  const rpId = location.hostname;
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: "Smart account PoC" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "smart-account-delegate", displayName: "Smart account delegate" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      // ES256 (P-256), the curve Soroban can verify.
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      attestation: "none",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created");

  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey();
  if (response.getPublicKeyAlgorithm() !== -7 || !spki) throw new Error("This authenticator did not create an ES256 (P-256) passkey");
  const bytes = new Uint8Array(spki);
  if (bytes.length !== 91 || hex(bytes.subarray(0, 26)) !== P256_SPKI_PREFIX || bytes[26] !== 0x04) {
    throw new Error("The passkey's public key is not an uncompressed P-256 key");
  }
  return { credentialId: toBase64Url(credential.rawId), publicKeyHex: hex(bytes.subarray(26)), rpId };
}

/** Signs a pending request with the delegate passkey: the payload is the WebAuthn challenge. */
export function passkeySigner(passkey: PasskeyDelegate): BrowserSigner {
  return {
    id: "passkey",
    label: "Sign with your passkey",
    appliesTo: (request: PendingSignature) =>
      request.kind === "auth-entry" && request.signer.kind === "passkey" && request.signer.id === passkey.publicKeyHex && location.hostname === passkey.rpId,
    async sign(request: PendingSignature): Promise<SignatureResponse> {
      if (request.kind !== "auth-entry") throw new Error("A passkey signs authorizations, not whole transactions");
      const assertion = (await navigator.credentials.get({
        publicKey: {
          challenge: fromHex(request.payloadHex),
          rpId: passkey.rpId,
          allowCredentials: [{ type: "public-key", id: fromBase64Url(passkey.credentialId) }],
          userVerification: "required",
          timeout: 60_000,
        },
      })) as PublicKeyCredential | null;
      if (!assertion) throw new Error("No passkey signature was produced");
      const response = assertion.response as AuthenticatorAssertionResponse;
      return {
        kind: "passkey",
        authenticatorData: toBase64(response.authenticatorData),
        clientDataJson: toBase64(response.clientDataJSON),
        signature: toBase64(response.signature),
      };
    },
  };
}
