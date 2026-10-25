import type { Snapshot, StepResult } from "@poc/core";

export interface StepMeta {
  n: number;
  name: string;
  signer: "master" | "delegate";
  expected: "success" | "failure";
}

export interface PolicyRule {
  contract: string;
  function: string;
  self_arg: boolean;
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
  delegatePolicy: PolicyRule[] | null;
  readError?: string;
  steps: StepMeta[];
  results: Record<string, StepResult>;
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
  | { action: "steps"; from: number; to: number };
