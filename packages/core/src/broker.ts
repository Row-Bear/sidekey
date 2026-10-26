import { randomUUID } from "node:crypto";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { type Authorizer, flattenInvocation } from "./chain.js";
import { type CallContext, describeCall, ed25519SignatureScVal, messageSignatureScVal } from "./policy.js";
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
  | { kind: "message"; signature: string };

/** A request as the browser sees it. */
export interface PendingSignature {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** The smart account being authorized. */
  account: string;
  signer: { label: string; /** hex of the raw ed25519 key */ id: string; address: string };
  /** What is being authorized, one line per invocation (root and nested). */
  summary: string[];
  /** The 32-byte hash to sign, hex. */
  payloadHex: string;
  /** The SEP-53 text to hand to `signMessage` for the `message` kind. */
  message: string;
  /** The auth-entry preimage (base64 XDR) to hand to `signAuthEntry` for the `payload` kind. */
  preimageXdr: string;
}

export type SubmitResult = { ok: true } | { ok: false; reason: "unknown" | "invalid"; message: string };

export class SigningCancelled extends Error {
  constructor(message = "Signing was cancelled") {
    super(message);
    this.name = "SigningCancelled";
  }
}

export interface BrokerRequest {
  account: string;
  signerRaw: Uint8Array;
  signerLabel: string;
  preimageXdr: string;
  payload: Uint8Array;
  summary: string[];
  /** Overrides the broker's default timeout. */
  timeoutMs?: number;
}

interface Waiting {
  view: PendingSignature;
  signerRaw: Uint8Array;
  payload: Uint8Array;
  resolve: (value: xdr.ScVal) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const DEFAULT_SIGNING_TIMEOUT_MS = 3 * 60 * 1000;

export class SignatureBroker {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly defaultTimeoutMs = DEFAULT_SIGNING_TIMEOUT_MS) {}

  /** Waits for the browser to sign. Rejects on cancel or timeout; resolves at most once. */
  request(req: BrokerRequest): Promise<xdr.ScVal> {
    const id = randomUUID();
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const now = Date.now();
    const view: PendingSignature = {
      id,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + timeoutMs).toISOString(),
      account: req.account,
      signer: {
        label: req.signerLabel,
        id: Buffer.from(req.signerRaw).toString("hex"),
        address: StrKey.encodeEd25519PublicKey(Buffer.from(req.signerRaw)),
      },
      summary: req.summary,
      payloadHex: Buffer.from(req.payload).toString("hex"),
      message: walletMessage(req.account, req.payload),
      preimageXdr: req.preimageXdr,
    };
    return new Promise<xdr.ScVal>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new SigningCancelled("Timed out waiting for a signature"));
      }, timeoutMs);
      this.waiting.set(id, { view, signerRaw: req.signerRaw, payload: req.payload, resolve, reject, timer });
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

    let scVal: xdr.ScVal;
    try {
      scVal = this.verified(waiting, response);
    } catch (err) {
      return { ok: false, reason: "invalid", message: err instanceof Error ? err.message : String(err) };
    }
    this.settle(id);
    waiting.resolve(scVal);
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

  private verified(waiting: Waiting, response: SignatureResponse): xdr.ScVal {
    const key = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(waiting.signerRaw)));
    const signature = decodeWalletSignature(String((response as { signature?: unknown }).signature ?? ""));
    switch (response?.kind) {
      case "payload":
        if (!key.verify(Buffer.from(waiting.payload), signature)) {
          throw new Error(`That is not ${waiting.view.signer.label}'s signature over the payload`);
        }
        return ed25519SignatureScVal(waiting.signerRaw, signature);
      case "message":
        if (!key.verify(sep53Digest(waiting.view.message), signature)) {
          throw new Error(`That is not ${waiting.view.signer.label}'s signature over the SEP-53 message`);
        }
        return messageSignatureScVal(waiting.signerRaw, signature);
      default:
        throw new Error('Unknown signature kind; expected "payload" or "message"');
    }
  }
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
  /** Raw ed25519 key of the signer the browser must sign as. */
  signerRaw: Uint8Array;
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
