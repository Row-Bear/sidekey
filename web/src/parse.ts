// Checks and rebuilds what the browser sends to the API, keeping only the known fields. Shared by the dev server and
// the in-browser backend of the static build.
import { StrKey } from "@stellar/stellar-sdk";
import {
  type CallRequest,
  type ConstraintInput,
  type ExpiryInput,
  type PasskeyDelegate,
  type PolicyOp,
  type SignatureResponse,
  STEPS,
} from "../../packages/core/src/browser.ts";
import type { RunRequest } from "./api-types.ts";

export const isText = (v: unknown): v is string => typeof v === "string";

/** Rebuilds a call request from untrusted JSON, keeping only the known fields. */
export function parseCallRequest(body: unknown): CallRequest {
  const c = (body ?? {}) as Record<string, unknown>;
  if (isText(c.contract) && isText(c.function) && isText(c.signer) && Array.isArray(c.args) && c.args.every(isText)) {
    return { contract: c.contract, function: c.function, signer: c.signer, args: [...c.args] };
  }
  throw new Error("Invalid call: expected contract, function and signer as text and args as a list of text");
}

export function parseExpiry(value: unknown): ExpiryInput | undefined {
  if (value === undefined) return undefined;
  const e = value as Record<string, unknown>;
  if (e?.kind === "none") return { kind: "none" };
  if (e?.kind === "minutes" && typeof e.minutes === "number") return { kind: "minutes", minutes: e.minutes };
  if (e?.kind === "ledger" && typeof e.ledger === "number") return { kind: "ledger", ledger: e.ledger };
  throw new Error('Invalid expiry: expected {kind:"none"}, {kind:"minutes",minutes} or {kind:"ledger",ledger}');
}

export function parsePolicyOp(body: unknown): PolicyOp {
  const p = (body ?? {}) as Record<string, unknown>;
  if (!isText(p.signer)) throw new Error("Invalid policy edit: signer is required");
  switch (p.op) {
    case "allow": {
      const constraints = p.constraints;
      const valid = Array.isArray(constraints) && constraints.every((c) =>
        c && ["any", "self", "exact", "lessThan"].includes(c.kind) && (c.value === undefined || isText(c.value)));
      if (!isText(p.contract) || !isText(p.function) || !valid) {
        throw new Error("Invalid policy edit: allow needs contract, function and a list of constraints");
      }
      const list = (constraints as ConstraintInput[]).map((c) => ({ kind: c.kind, ...(c.value !== undefined ? { value: c.value } : {}) }));
      return { op: "allow", signer: p.signer, contract: p.contract, function: p.function, constraints: list, expiry: parseExpiry(p.expiry) };
    }
    case "remove-rule":
      if (isText(p.contract) && isText(p.function)) return { op: "remove-rule", signer: p.signer, contract: p.contract, function: p.function };
      break;
    case "set-expiry": {
      const expiry = parseExpiry(p.expiry);
      if (expiry) return { op: "set-expiry", signer: p.signer, expiry };
      break;
    }
    case "revoke":
      return { op: "revoke", signer: p.signer };
  }
  throw new Error("Invalid policy edit");
}

/** Whether signatures come from the browser (wallet, passkey, pasted) instead of the demo's own keys. */
const parseVia = (value: unknown): { via?: "browser" } => (value === "browser" ? { via: "browser" } : {});

type SignatureBody = { id: string; response: SignatureResponse } | { id: string; cancel: true; reason?: string };

export function parseSignatureBody(body: unknown): SignatureBody {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!isText(b.id)) throw new Error("Invalid signature answer: id is required");
  if (b.cancel === true) return { id: b.id, cancel: true, ...(isText(b.reason) ? { reason: b.reason } : {}) };
  const r = (b.response ?? {}) as Record<string, unknown>;
  if ((r.kind === "payload" || r.kind === "message") && isText(r.signature)) {
    return { id: b.id, response: { kind: r.kind, signature: r.signature } };
  }
  if (r.kind === "transaction" && isText(r.signedXdr)) return { id: b.id, response: { kind: "transaction", signedXdr: r.signedXdr } };
  if (r.kind === "passkey" && isText(r.authenticatorData) && isText(r.clientDataJson) && isText(r.signature)) {
    return {
      id: b.id,
      response: { kind: "passkey", authenticatorData: r.authenticatorData, clientDataJson: r.clientDataJson, signature: r.signature },
    };
  }
  throw new Error(
    'Invalid signature answer: expected response {kind: "payload" | "message", signature}, {kind: "transaction", signedXdr}, {kind: "passkey", authenticatorData, clientDataJson, signature} or cancel: true',
  );
}

/** A passkey the browser just created; its relying party must be the host the page is served from. */
export function parsePasskey(body: Record<string, unknown>, host: string): PasskeyDelegate {
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const { credentialId, publicKeyHex, rpId } = body;
  if (!isText(credentialId) || !/^[A-Za-z0-9_-]{8,1024}$/.test(credentialId)) throw new Error("Invalid passkey: credentialId must be base64url");
  if (!isText(publicKeyHex) || !/^04[0-9a-f]{128}$/.test(publicKeyHex)) throw new Error("Invalid passkey: publicKeyHex must be a 65-byte uncompressed P-256 key");
  if (!isText(rpId) || rpId !== hostname) throw new Error(`Invalid passkey: its relying party must be ${hostname}`);
  return { credentialId, publicKeyHex, rpId };
}

export function parseAddress(value: unknown): string {
  if (isText(value) && StrKey.isValidEd25519PublicKey(value)) return value;
  throw new Error("Invalid wallet address: expected a Stellar G address");
}

export function parseRunRequest(body: unknown): RunRequest {
  const b = body as Partial<RunRequest> & { from?: unknown; to?: unknown; call?: unknown; policy?: unknown; via?: unknown };
  if (b.action === "full" || b.action === "fresh") return { action: b.action };
  if (b.action === "wallet-account") return { action: "wallet-account", address: parseAddress((b as { address?: unknown }).address) };
  if (b.action === "wallet-fund") return { action: "wallet-fund", address: parseAddress((b as { address?: unknown }).address) };
  if (b.action === "record-account") return { action: "record-account", address: parseAddress((b as { address?: unknown }).address) };
  if (b.action === "call") return { action: "call", call: parseCallRequest(b.call), ...parseVia(b.via) };
  if (b.action === "policy") return { action: "policy", policy: parsePolicyOp(b.policy), ...parseVia(b.via) };
  if (b.action === "steps") {
    const from = Number(b.from);
    const to = Number(b.to);
    const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= STEPS.length;
    if (valid(from) && valid(to) && from <= to) return { action: "steps", from, to, ...parseVia(b.via) };
  }
  throw new Error(`Invalid run request; expected action "full", "fresh", "steps" (from/to in 1-${STEPS.length}), "call", "policy", "wallet-account", "wallet-fund" or "record-account"`);
}

