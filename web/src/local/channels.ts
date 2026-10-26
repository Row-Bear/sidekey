// The relayer the static build uses to submit transactions, so the user never needs XLM for fees:
// OpenZeppelin's Channels service. Each browser asks the service for its own API key the first time (the key
// endpoint is public), so no key ships with the page and the fair-use limit is per user.
import type { xdr } from "@stellar/stellar-sdk";
import type { Relay } from "../../../packages/core/src/browser.ts";

const KEY_STORAGE = "sidekey.channelsKey";

export const CHANNELS_URL = (import.meta.env?.VITE_CHANNELS_URL as string | undefined) ?? "https://channels.openzeppelin.com/testnet";

async function apiKey(): Promise<string> {
  const configured = import.meta.env?.VITE_CHANNELS_API_KEY as string | undefined;
  if (configured) return configured;
  const stored = localStorage.getItem(KEY_STORAGE);
  if (stored) return stored;
  const res = await fetch(`${CHANNELS_URL}/gen`);
  const body = (await res.json().catch(() => ({}))) as { apiKey?: string };
  if (!body.apiKey) throw new Error(`Could not get a relayer key (${res.status})`);
  localStorage.setItem(KEY_STORAGE, body.apiKey);
  return body.apiKey;
}

interface ChannelsResult {
  hash: string | null;
  status: string;
}

async function call(params: Record<string, unknown>): Promise<{ hash: string }> {
  const res = await fetch(CHANNELS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await apiKey()}` },
    body: JSON.stringify({ params }),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: ChannelsResult & { details?: unknown }; error?: string } | null;
  if (!body || body.success === undefined) throw new Error(`The relayer did not answer properly (${res.status})`);
  if (!body.success) throw new Error(`The relayer refused it: ${body.error ?? "unknown error"}`);
  if (!body.data?.hash) throw new Error(`The relayer returned no transaction hash (status ${body.data?.status ?? "unknown"})`);
  return { hash: body.data.hash };
}

/** Submits a host function and its signed authorization; the service builds the transaction and pays. */
export const relay: Relay = (func: xdr.HostFunction, auth: xdr.SorobanAuthorizationEntry[]) =>
  call({ func: func.toXDR("base64"), auth: auth.map((a) => a.toXDR("base64")) });

/** Submits a transaction a wallet signed; the service wraps it in a fee bump. */
export const relayTransaction = (signedXdr: string) => call({ xdr: signedXdr });
