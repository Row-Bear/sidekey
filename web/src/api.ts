import type { CallRequest, FunctionInfo, PreviewResult, RuleView, SignatureResponse, SignerView, StepResult } from "@poc/core";
import type { DemoState, RunRequest } from "./api-types";

export async function fetchState(): Promise<DemoState> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`State request failed (${res.status})`);
  return (await res.json()) as DemoState;
}

export interface SignersResponse {
  smartAccount: string;
  simulator: string;
  /** The native XLM token contract. */
  nativeToken: string;
  /** The master's G address (a connected wallet in wallet mode). */
  master: string;
  latestLedger: number;
  /** What this smart account's contract can enforce; older accounts lack some features. */
  features: { lessThan: boolean };
  signers: SignerView[];
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

/** `demo: false` leaves out the demo's own delegate key, which the plain page does not use. */
export const fetchSigners = (demo = true) => getJson<SignersResponse>(demo ? "/api/signers" : "/api/signers?demo=0");

export async function fetchFunctions(contract: string): Promise<FunctionInfo[]> {
  return (await getJson<{ functions: FunctionInfo[] }>(`/api/contract-functions?id=${encodeURIComponent(contract)}`)).functions;
}

export const requestPreview = (call: CallRequest) =>
  getJson<PreviewResult>("/api/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(call),
  });

/** Sends the browser's signature for a pending request; throws the server's message if it is refused. */
export async function submitSignature(id: string, response: SignatureResponse): Promise<void> {
  await getJson("/api/signature", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, response }),
  });
}

export async function cancelSignature(id: string, reason?: string): Promise<void> {
  await getJson("/api/signature", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, cancel: true, reason }),
  });
}

export type WalletStatus = { exists: false } | { exists: true; stroops: string };

export const fetchWalletStatus = (address: string) => getJson<WalletStatus>(`/api/wallet-status?address=${encodeURIComponent(address)}`);

export const setMasterMode = (mode: "demo" | "wallet") =>
  getJson<{ mode: string }>("/api/mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });

export const fetchRecordedAccounts = (address: string) =>
  getJson<{ accounts: { index: number; smartAccountId: string }[] }>(`/api/wallet-accounts?address=${address}`);

export const loadWalletAccount = (address: string, smartAccountId: string) =>
  getJson<{ wallet: { address: string; smartAccountId: string } }>("/api/wallet-load", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, smartAccountId }),
  });

export const registerPasskey = (passkey: { credentialId: string; publicKeyHex: string; rpId: string }) =>
  getJson<{ delegate: string }>("/api/passkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "register", ...passkey }),
  });

export const selectDelegate = (delegate: "key" | "passkey") =>
  getJson<{ delegate: string }>("/api/passkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "select", delegate }),
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

/** A G or C address shortened; anything else (a passkey's name) is shown as it is. */
export const shortAddress = (address: string) =>
  /^[GC][A-Z2-7]{55}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;

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
/** Shortens every full G or C address inside a text (a call's title), so a long id does not take over a line. */
export const shortenAddresses = (text: string): string =>
  text.replace(/\b[GC][A-Z2-7]{55}\b/g, (address) => `${address.slice(0, 6)}…${address.slice(-6)}`);

/** A plain-language version of a contract or host error, with the original kept for anyone who wants it. */
export function friendlyError(raw: string): { summary: string; detail?: string } {
  if (/Storage, MissingValue/.test(raw)) {
    return {
      summary: "The contract could not run this call: it reads data that does not exist yet, for example for an account with no position there.",
      detail: raw,
    };
  }
  const contractError = /Error\(Contract, #(\d+)\)/.exec(raw);
  if (contractError) {
    return { summary: `The contract refused the call (its error #${contractError[1]}).`, detail: raw };
  }
  if (/^HostError:/.test(raw) || raw.length > 160) return { summary: "The call could not be run.", detail: raw };
  return { summary: raw };
}

/** A rough duration: seconds, minutes, hours or days, whichever reads best. */
export function durationText(seconds: number): string {
  const minutes = seconds / 60;
  if (seconds < 90) return `${Math.max(Math.round(seconds), 0)} s`;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 36) return `${Number(hours.toFixed(1))} h`;
  return `${Number((hours / 24).toFixed(1))} days`;
}

export function expiryText(validUntil: number, latest: number): string {
  const seconds = (validUntil - latest) * SECONDS_PER_LEDGER;
  const left = durationText(seconds);
  return `expires in about ${left} (ledger ${validUntil.toLocaleString("en-US")})`;
}

/** Human-readable rule, e.g. `claim(this account)` or `withdraw(this account, any)`. */
export function describeRule(rule: RuleView): string {
  const args = rule.args.map((a) =>
    a.kind === "self" ? "this account" : a.kind === "any" ? "any" : a.kind === "lessThan" ? `< ${a.limit}` : `= ${a.display}`,
  );
  return `${rule.function}(${args.join(", ")})`;
}

export function stepStatus(result: StepResult | undefined, running: boolean): StepStatus {
  if (running) return "running";
  if (!result) return "pending";
  if (!result.asExpected) return "unexpected";
  return result.outcome === "success" ? "succeeded" : "blocked";
}
