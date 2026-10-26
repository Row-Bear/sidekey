import { randomUUID } from "node:crypto";
import { Keypair, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { type Authorizer, flattenInvocation } from "./chain.js";
import { checkAssertion, derToCompactLowS, verifyPasskeySignature } from "./passkey.js";
import { type CallContext, describeCall, ed25519SignatureScVal, messageSignatureScVal, passkeySignatureScVal } from "./policy.js";
import { decodeWalletSignature, sep53Digest, walletMessage } from "./wallet.js";

// The signature broker. A server-side job needs a signature that only the browser can produce (a
// wallet, a passkey, a person pasting one). The broker turns that into a promise the job awaits and a
// pending item the browser can see and answer. It owns validation: an answer only counts if it is a
// valid signature by the one key the request is for, so a browser can neither pick the signer nor
// feed the job a bad signature.

/** What the browser sends back. More kinds (a passkey assertion) are added here. */
export type SignatureResponse =
  /** ed25519 signature over the 32-byte payload: what a wallet's `signAuthEntry` returns. */
  | { kind: "payload"; signature: string }
  /** ed25519 signature over the SEP-53 digest of `message`: what a wallet's `signMessage` returns. */
  | { kind: "message"; signature: string }
  /** The same transaction, signed: what a wallet's `signTransaction` returns. */
  | { kind: "transaction"; signedXdr: string }
  /** A WebAuthn assertion (base64 each; the signature is the authenticator's DER). */
  | { kind: "passkey"; authenticatorData: string; clientDataJson: string; signature: string };

interface PendingBase {
  id: string;
  createdAt: string;
  expiresAt: string;
  signer: {
    label: string;
    kind: "ed25519" | "passkey";
    /** Hex of the raw public key: 32 bytes for ed25519, 65 for a passkey. */
    id: string;
    /** The G address of an ed25519 signer; for a passkey, a short readable name. */
    address: string;
  };
  /** What is being authorized, one line per invocation (root and nested). */
  summary: string[];
}

/** The smart account's authorization of a call, to be signed as a payload or a SEP-53 message. */
export interface PendingAuthEntry extends PendingBase {
  kind: "auth-entry";
  /** The smart account being authorized. */
  account: string;
  /** The 32-byte hash to sign, hex. */
  payloadHex: string;
  /** The SEP-53 text to hand to `signMessage` for the `message` kind. */
  message: string;
  /** The auth-entry preimage (base64 XDR) to hand to `signAuthEntry` for the `payload` kind. */
  preimageXdr: string;
}

/** A whole transaction the signer's G account is the source of, to be signed by a wallet. */
export interface PendingTransaction extends PendingBase {
  kind: "transaction";
  transactionXdr: string;
  networkPassphrase: string;
  /** The transaction hash, hex. */
  transactionHashHex: string;
}

/** A request as the browser sees it. */
export type PendingSignature = PendingAuthEntry | PendingTransaction;

export type SubmitResult = { ok: true } | { ok: false; reason: "unknown" | "invalid"; message: string };

export class SigningCancelled extends Error {
  constructor(message = "Signing was cancelled") {
    super(message);
    this.name = "SigningCancelled";
  }
}

export interface BrokerRequest {
  account: string;
  /** The signer's public key: 32 bytes (ed25519) or 65 (a passkey, which also needs `rpIdHash`). */
  signerRaw: Uint8Array;
  /** For a passkey: sha256 of the relying party id it is bound to (from the account's policy). */
  rpIdHash?: Uint8Array;
  signerLabel: string;
  preimageXdr: string;
  payload: Uint8Array;
  summary: string[];
  /** Overrides the broker's default timeout. */
  timeoutMs?: number;
}

export interface TransactionRequest {
  signerRaw: Uint8Array;
  signerLabel: string;
  /** The unsigned transaction envelope (base64 XDR); its source must be the signer's account. */
  transactionXdr: string;
  networkPassphrase: string;
  summary: string[];
  timeoutMs?: number;
}

interface Waiting {
  view: PendingSignature;
  /** Checks the browser's answer and returns what the job gets; throws a readable error if it is no good. */
  accept: (response: SignatureResponse) => unknown;
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_SIGNING_TIMEOUT_MS = 3 * 60 * 1000;

export class SignatureBroker {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly defaultTimeoutMs = DEFAULT_SIGNING_TIMEOUT_MS) {}

  /** Waits for the browser to sign an auth entry. Rejects on cancel or timeout; resolves at most once. */
  request(req: BrokerRequest): Promise<xdr.ScVal> {
    const isPasskey = req.signerRaw.length === 65;
    if (isPasskey && !req.rpIdHash) throw new Error("A passkey request needs the relying party hash");
    const key = isPasskey ? null : Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(req.signerRaw)));
    const message = walletMessage(req.account, req.payload);
    return this.enqueue<xdr.ScVal>(
      req,
      (base) => ({
        ...base,
        kind: "auth-entry",
        account: req.account,
        payloadHex: Buffer.from(req.payload).toString("hex"),
        message,
        preimageXdr: req.preimageXdr,
      }),
      (response) => {
        if (response.kind === "passkey") {
          if (!isPasskey) throw new Error(`${req.signerLabel} is a key, not a passkey`);
          const assertion = {
            authenticatorData: Buffer.from(response.authenticatorData, "base64"),
            clientDataJson: Buffer.from(response.clientDataJson, "base64"),
          };
          // The same checks the contract makes, so a bad answer is refused here and can be retried.
          checkAssertion({ rpIdHash: req.rpIdHash!, payload: req.payload }, assertion);
          const compact = derToCompactLowS(Buffer.from(response.signature, "base64"));
          if (!verifyPasskeySignature(req.signerRaw, assertion, compact)) {
            throw new Error(`That is not ${req.signerLabel}'s passkey signature`);
          }
          return passkeySignatureScVal({ publicKey: req.signerRaw, ...assertion, signature: compact });
        }
        if (isPasskey) throw new Error(`${req.signerLabel} is a passkey: it must answer with a passkey assertion`);
        const signature = signatureOf(response);
        switch (response.kind) {
          case "payload":
            if (!key!.verify(Buffer.from(req.payload), signature)) {
              throw new Error(`That is not ${req.signerLabel}'s signature over the payload`);
            }
            return ed25519SignatureScVal(req.signerRaw, signature);
          case "message":
            if (!key!.verify(sep53Digest(message), signature)) {
              throw new Error(`That is not ${req.signerLabel}'s signature over the SEP-53 message`);
            }
            return messageSignatureScVal(req.signerRaw, signature);
          default:
            throw new Error('Expected a "payload" or "message" signature for this request');
        }
      },
    );
  }

  /**
   * Waits for a wallet to sign a transaction. The job gets the transaction rebuilt from its own copy plus
   * the one verified signature, so anything else in the wallet's answer (extra signatures, edits) is dropped.
   */
  requestTransaction(req: TransactionRequest): Promise<string> {
    const address = StrKey.encodeEd25519PublicKey(Buffer.from(req.signerRaw));
    const key = Keypair.fromPublicKey(address);
    const original = parseTransaction(req.transactionXdr, req.networkPassphrase);
    const hash = Buffer.from(original.hash());
    return this.enqueue<string>(
      req,
      (base) => ({
        ...base,
        kind: "transaction",
        transactionXdr: req.transactionXdr,
        networkPassphrase: req.networkPassphrase,
        transactionHashHex: hash.toString("hex"),
      }),
      (response) => {
        if (response.kind !== "transaction") throw new Error('Expected a signed "transaction" for this request');
        const signed = parseTransaction(response.signedXdr, req.networkPassphrase);
        if (!Buffer.from(signed.hash()).equals(hash)) {
          throw new Error("The wallet changed the transaction (its hash differs), so the signature is not accepted");
        }
        const hint = Buffer.from(key.signatureHint());
        const mine = signed.signatures.find((s) => Buffer.from(s.hint.value).equals(hint) && key.verify(hash, Buffer.from(s.signature.value)));
        if (!mine) throw new Error(`The transaction is not signed by ${req.signerLabel} (${address})`);
        const result = parseTransaction(req.transactionXdr, req.networkPassphrase);
        result.addSignature(address, Buffer.from(mine.signature.value).toString("base64"));
        return result.toXDR();
      },
    );
  }

  private enqueue<T>(
    req: { signerRaw: Uint8Array; signerLabel: string; summary: string[]; timeoutMs?: number },
    view: (base: PendingBase) => PendingSignature,
    accept: (response: SignatureResponse) => unknown,
  ): Promise<T> {
    const id = randomUUID();
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const now = Date.now();
    const base: PendingBase = {
      id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
      signer: {
        label: req.signerLabel,
        kind: req.signerRaw.length === 65 ? "passkey" : "ed25519",
        id: Buffer.from(req.signerRaw).toString("hex"),
        address:
          req.signerRaw.length === 65
            ? `passkey ${Buffer.from(req.signerRaw).toString("hex").slice(2, 10)}…`
            : StrKey.encodeEd25519PublicKey(Buffer.from(req.signerRaw)),
      },
      summary: req.summary,
    };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new SigningCancelled("Timed out waiting for a signature"));
      }, timeoutMs);
      this.waiting.set(id, { view: view(base), accept, resolve: resolve as (v: never) => void, reject, timer });
    });
  }

  pending(): PendingSignature[] {
    return [...this.waiting.values()].map((w) => w.view);
  }

  /**
   * Accepts the browser's answer. A wrong or malformed signature is refused and the request stays
   * pending, so the person can try again; a good one resolves the job exactly once.
   */
  submit(id: string, response: SignatureResponse): SubmitResult {
    const waiting = this.waiting.get(id);
    if (!waiting) return { ok: false, reason: "unknown", message: "No such signing request (it may have expired or already been answered)" };

    let value: unknown;
    try {
      value = waiting.accept(response ?? ({} as SignatureResponse));
    } catch (err) {
      return { ok: false, reason: "invalid", message: err instanceof Error ? err.message : String(err) };
    }
    this.settle(id);
    waiting.resolve(value as never);
    return { ok: true };
  }

  /** Ends a request without a signature; the job that was waiting fails with `SigningCancelled`. */
  cancel(id: string, reason?: string): boolean {
    const waiting = this.waiting.get(id);
    if (!waiting) return false;
    this.settle(id);
    waiting.reject(new SigningCancelled(reason));
    return true;
  }

  private settle(id: string): void {
    const waiting = this.waiting.get(id);
    if (waiting) clearTimeout(waiting.timer);
    this.waiting.delete(id);
  }
}

function signatureOf(response: SignatureResponse): Buffer {
  const raw = (response as { signature?: unknown }).signature;
  if (response?.kind === "transaction" || response?.kind === "passkey") throw new Error('Expected a "payload" or "message" signature for this request');
  return decodeWalletSignature(String(raw ?? ""));
}

function parseTransaction(xdrText: string, networkPassphrase: string): Transaction {
  const tx = TransactionBuilder.fromXDR(xdrText, networkPassphrase);
  if (!("operations" in tx) || "innerTransaction" in tx) throw new Error("Fee-bump transactions are not supported");
  return tx as Transaction;
}

/** The invocations an auth-entry preimage authorizes, as readable lines. */
export function summarizePreimage(preimageXdr: string): string[] {
  const preimage = xdr.HashIdPreimage.fromXDR(preimageXdr, "base64");
  const invocation =
    preimage.type === "envelopeTypeSorobanAuthorization"
      ? preimage.sorobanAuthorization.invocation
      : preimage.type === "envelopeTypeSorobanAuthorizationWithAddress"
        ? preimage.sorobanAuthorizationWithAddress.invocation
        : null;
  if (!invocation) throw new Error(`Not a Soroban authorization preimage (${preimage.type})`);
  const calls: CallContext[] = [];
  flattenInvocation(invocation, calls);
  return calls.map(describeCall);
}

export interface BrokerSignerInfo {
  account: string;
  /** The key the browser must sign as: 32 bytes (ed25519) or 65 (a passkey). */
  signerRaw: Uint8Array;
  /** For a passkey: sha256 of its relying party id. */
  rpIdHash?: Uint8Array;
  signerLabel: string;
  timeoutMs?: number;
}

/** The signing function for a `smart-remote` authorizer that waits on the broker. */
export function brokerSigner(broker: SignatureBroker, info: BrokerSignerInfo) {
  return (preimageXdr: string, payload: Uint8Array): Promise<xdr.ScVal> =>
    broker.request({ ...info, preimageXdr, payload, summary: summarizePreimage(preimageXdr) });
}

/** A `smart-remote` authorizer whose signatures come from the browser through the broker. */
export function brokerAuthorizer(broker: SignatureBroker, info: BrokerSignerInfo): Authorizer {
  return { kind: "smart-remote", address: info.account, sign: brokerSigner(broker, info) };
}
