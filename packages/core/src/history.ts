// Node-only: persists the history of custom calls and policy edits for the dashboard.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface CallRecord {
  id: string;
  at: string;
  /** A call made from the call builder, or a master-signed policy edit. */
  kind: "call" | "policy";
  title: string;
  /** Who signed: "master", "delegate" or a short key. */
  signer: string;
  outcome: "success" | "failure";
  txHash?: string;
  explorerUrl?: string;
  /** Set when the account's own policy refused the call (NotAllowed, SignerExpired, UnknownSigner). */
  rejectedByPolicy?: boolean;
  failureStage?: string;
  error?: string;
}

const MAX_RECORDS = 30;

export function loadCallHistory(path: string | URL): CallRecord[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CallRecord[]) : [];
}

/** Newest first, capped. */
export function saveCallRecord(path: string | URL, record: CallRecord): void {
  writeFileSync(path, JSON.stringify([record, ...loadCallHistory(path)].slice(0, MAX_RECORDS), null, 2) + "\n");
}

export function clearCallHistory(path: string | URL): void {
  writeFileSync(path, "[]\n");
}
