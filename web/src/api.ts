import type { CallRequest, FunctionInfo, PreviewResult, RuleView, SignerView, StepResult } from "@poc/core";
import type { DemoState, RunRequest } from "./api-types";

export async function fetchState(): Promise<DemoState> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`State request failed (${res.status})`);
  return (await res.json()) as DemoState;
}

export interface SignersResponse {
  smartAccount: string;
  simulator: string;
  latestLedger: number;
  signers: SignerView[];
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export const fetchSigners = () => getJson<SignersResponse>("/api/signers");

export async function fetchFunctions(contract: string): Promise<FunctionInfo[]> {
  return (await getJson<{ functions: FunctionInfo[] }>(`/api/contract-functions?id=${encodeURIComponent(contract)}`)).functions;
}

export const requestPreview = (call: CallRequest) =>
  getJson<PreviewResult>("/api/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(call),
  });

export const looksLikeContractId = (text: string) => /^C[A-Z2-7]{55}$/.test(text.trim());

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

// Testnet closes a ledger roughly every 5 seconds.
const SECONDS_PER_LEDGER = 5;

/** e.g. "expires in about 12 min (ledger 5,389,030)". */
export function expiryText(validUntil: number, latest: number): string {
  const seconds = (validUntil - latest) * SECONDS_PER_LEDGER;
  const left = seconds < 90 ? `${Math.max(seconds, 0)} s` : `${Math.round(seconds / 60)} min`;
  return `expires in about ${left} (ledger ${validUntil.toLocaleString("en-US")})`;
}

/** Human-readable rule, e.g. `claim(this account)` or `withdraw(this account, any)`. */
export function describeRule(rule: RuleView): string {
  const args = rule.args.map((a) => (a.kind === "self" ? "this account" : a.kind === "any" ? "any" : `= ${a.display}`));
  return `${rule.function}(${args.join(", ")})`;
}

export function stepStatus(result: StepResult | undefined, running: boolean): StepStatus {
  if (running) return "running";
  if (!result) return "pending";
  if (!result.asExpected) return "unexpected";
  return result.outcome === "success" ? "succeeded" : "blocked";
}
