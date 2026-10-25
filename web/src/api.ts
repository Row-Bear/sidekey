import type { StepResult } from "@poc/core";
import type { DemoState, RunRequest } from "./api-types";

export async function fetchState(): Promise<DemoState> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`State request failed (${res.status})`);
  return (await res.json()) as DemoState;
}

export async function startRun(request: RunRequest): Promise<void> {
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `Run request failed (${res.status})`);
}

const EXPLORER = "https://stellar.expert/explorer/testnet";
export const accountUrl = (address: string) => `${EXPLORER}/${address.startsWith("C") ? "contract" : "account"}/${address}`;

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`;

/** Amounts arrive as stroops (1 XLM = 10^7); trim to what is readable. */
export function formatXlm(stroops: string): string {
  const value = BigInt(stroops);
  const whole = value / 10_000_000n;
  const fraction = (value % 10_000_000n).toString().padStart(7, "0");
  return `${whole.toLocaleString("en-US")}.${fraction.slice(0, 4)}`;
}

export type StepStatus = "pending" | "running" | "succeeded" | "blocked" | "unexpected";

export function stepStatus(result: StepResult | undefined, running: boolean): StepStatus {
  if (running) return "running";
  if (!result) return "pending";
  if (!result.asExpected) return "unexpected";
  return result.outcome === "success" ? "succeeded" : "blocked";
}
