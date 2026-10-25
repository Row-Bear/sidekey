import { Networks } from "@stellar/stellar-sdk";

export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
export const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
export const NATIVE_TOKEN_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const STROOPS_PER_XLM = 10_000_000n;

export function requireEnv(name: string, env: Record<string, string | undefined> = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}
