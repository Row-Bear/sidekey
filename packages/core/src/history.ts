// The history of custom calls and policy edits shown in the dashboard. Where it is kept is up to the caller:
// see `history-file.ts`.

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
  /** The user declined to sign, or the request timed out: not a failure of the call itself. */
  cancelled?: boolean;
  failureStage?: string;
  error?: string;
}

const MAX_RECORDS = 30;

/** Newest first, capped. */
export const addCallRecord = (history: readonly CallRecord[], record: CallRecord): CallRecord[] => [record, ...history].slice(0, MAX_RECORDS);
