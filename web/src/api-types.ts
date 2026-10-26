import type { CallRecord, CallRequest, PendingSignature, PolicyOp, SignerPolicyView, Snapshot, StepResult } from "@poc/core";

export interface StepMeta {
  n: number;
  name: string;
  signer: "master" | "delegate";
  expected: "success" | "failure";
  /** Not part of the core 7-step demo (the expiry steps). */
  optional?: boolean;
}

export interface DemoState {
  network: "testnet";
  accounts: {
    sponsor: string;
    master: string;
    delegate: string;
    smartAccount: string;
    simulator: string;
  };
  /** Live on-chain values; null when the RPC read failed (see `readError`). */
  snapshot: Snapshot | null;
  /** The delegate's policy on the account: expiry and rules. Null if it is not registered or unreadable. */
  delegatePolicy: SignerPolicyView | null;
  latestLedger: number | null;
  readError?: string;
  steps: StepMeta[];
  results: Record<string, StepResult>;
  /** Calls made from the call builder and policy edits, newest first. */
  calls: CallRecord[];
  /** Signatures the server is waiting for the browser to provide. */
  pendingSignatures: PendingSignature[];
  run: {
    busy: boolean;
    /** The step being executed right now, if any. */
    currentStep: number | null;
    label: string | null;
    log: string[];
    lastError: string | null;
  };
  updatedAt: string;
}

export type RunRequest =
  | { action: "full" }
  | { action: "fresh" }
  | { action: "steps"; from: number; to: number; via?: SigningVia }
  | { action: "call"; call: CallRequest; via?: SigningVia }
  | { action: "policy"; policy: PolicyOp; via?: SigningVia };

/** Where signatures come from: the demo's own keys (default) or the browser (wallet, passkey, pasted). */
export type SigningVia = "browser";
