import type { PendingSignature, SignatureResponse } from "@poc/core";

/**
 * A way to produce a signature in the browser without the person copying anything: a connected
 * wallet, or a passkey. The signing modal lists the ones that apply to a request and always offers
 * the manual option. Wallets (WP4) and passkeys (WP5) register themselves here.
 */
export interface BrowserSigner {
  id: string;
  /** Button text, e.g. "Sign with xBull". */
  label: string;
  /** Whether this signer can answer `request` (right key, connected, supported). */
  appliesTo(request: PendingSignature): boolean;
  sign(request: PendingSignature): Promise<SignatureResponse>;
}

export const browserSigners: BrowserSigner[] = [];
