import { hash } from "@stellar/stellar-sdk";
import { Keypair, type xdr } from "@stellar/stellar-sdk";
import { messageSignatureScVal } from "./policy.js";

// Signing a smart-account authorization with a wallet that only offers `signMessage` (SEP-53),
// as xBull, Albedo and others do. The contract accepts a `Message` signature over
// `sha256("Stellar Signed Message:\n" + walletMessage(account, payload))`.

export const SEP53_PREFIX = "Stellar Signed Message:\n";

/**
 * The text the wallet is asked to sign. It must match the contract byte for byte. It contains spaces on
 * purpose: xBull decodes a message as base64 when it looks like base64 (a bare hex payload does), and
 * spaces keep every wallet reading it as plain UTF-8.
 */
export const walletMessage = (account: string, payload: Uint8Array): string =>
  `Authorize ${account} payload ${Buffer.from(payload).toString("hex")}`;

/** What SEP-53 says is signed: sha256 of the prefix plus the message bytes. */
export const sep53Digest = (message: string): Buffer =>
  Buffer.from(hash(Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(message, "utf8")])));

/** The part of a SEP-43 wallet (or the Wallets Kit) used here. */
export interface MessageWallet {
  signMessage(message: string, opts?: { networkPassphrase?: string; address?: string }): Promise<{ signedMessage: string; signerAddress?: string }>;
}

/** A 64-byte ed25519 signature given as base64 or hex, as different wallets return it. */
export function decodeWalletSignature(text: string): Buffer {
  const value = text.trim();
  const candidates = [/^[0-9a-fA-F]{128}$/.test(value) ? Buffer.from(value, "hex") : null, Buffer.from(value, "base64")];
  const found = candidates.find((c) => c !== null && c.length === 64);
  if (!found) throw new Error("The wallet's signature is not 64 bytes in base64 or hex");
  return found;
}

export interface WalletSignOptions {
  /** The smart account (C…) being authorized. */
  account: string;
  /** The master's G address, which the wallet must sign with. */
  masterAddress: string;
  networkPassphrase?: string;
}

/**
 * Builds the signing callback for a `smart-remote` authorizer: asks the wallet to sign the message
 * for the payload, checks the signature locally against the master key (so a wallet that signed
 * something else is caught here, with a clear error, not as an on-chain rejection), and returns the
 * `Message` signature the contract expects.
 */
export function walletMessageSigner(wallet: MessageWallet, options: WalletSignOptions) {
  const master = Keypair.fromPublicKey(options.masterAddress);
  return async (_preimageXdr: string, payload: Uint8Array): Promise<xdr.ScVal> => {
    const message = walletMessage(options.account, payload);
    const result = await wallet.signMessage(message, { address: options.masterAddress, networkPassphrase: options.networkPassphrase });
    if (result.signerAddress && result.signerAddress !== options.masterAddress) {
      throw new Error(`The wallet signed with ${result.signerAddress}, not the master ${options.masterAddress}`);
    }
    const signature = decodeWalletSignature(result.signedMessage);
    if (!master.verify(sep53Digest(message), signature)) {
      throw new Error(
        "The wallet's signature does not match the SEP-53 message that was requested. " +
          "The wallet may have changed the message (for example by treating it as base64).",
      );
    }
    return messageSignatureScVal(master.rawPublicKey(), signature);
  };
}
