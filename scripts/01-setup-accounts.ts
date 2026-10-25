import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { FRIENDBOT_URL } from "@poc/core";

const ENV_PATH = new URL("../.env", import.meta.url);
const HORIZON_URL = "https://horizon-testnet.stellar.org";

type Role = "SPONSOR" | "MASTER" | "DELEGATE";

// The delegate only signs Soroban auth entries, so it never needs an on-chain account.
const ROLES: { role: Role; fund: boolean; purpose: string }[] = [
  { role: "SPONSOR", fund: true, purpose: "transaction source and fee payer" },
  { role: "MASTER", fund: true, purpose: "default G signer of the smart account" },
  { role: "DELEGATE", fund: false, purpose: "policy-limited signer (auth only)" },
];

function setEnvValues(values: Record<string, string>): void {
  let text = readFileSync(ENV_PATH, "utf8");
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
  }
  writeFileSync(ENV_PATH, text);
}

async function nativeBalance(publicKey: string): Promise<string | null> {
  const res = await fetch(`${HORIZON_URL}/accounts/${publicKey}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon ${res.status} for ${publicKey}`);
  const body = (await res.json()) as { balances: { asset_type: string; balance: string }[] };
  return body.balances.find((b) => b.asset_type === "native")?.balance ?? "0";
}

async function friendbot(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`Friendbot ${res.status}: ${await res.text()}`);
}

async function main(): Promise<void> {
  const updates: Record<string, string> = {};

  for (const { role, fund, purpose } of ROLES) {
    const existingSecret = process.env[`${role}_SECRET`];
    const keypair = existingSecret ? Keypair.fromSecret(existingSecret) : Keypair.random();
    const publicKey = keypair.publicKey();

    if (existingSecret && process.env[`${role}_PUBLIC`] !== publicKey) {
      throw new Error(`${role}_PUBLIC in .env does not match ${role}_SECRET`);
    }
    updates[`${role}_PUBLIC`] = publicKey;
    updates[`${role}_SECRET`] = keypair.secret();

    if (fund) {
      if ((await nativeBalance(publicKey)) === null) {
        await friendbot(publicKey);
        console.log(`${role}: funded via Friendbot`);
      }
    }
    // Persist after each role so a later failure never loses a generated secret.
    setEnvValues(updates);
    console.log(`${role}: ${publicKey} (${purpose})`);
  }

  console.log("\nBalances (XLM):");
  for (const { role, fund } of ROLES) {
    const balance = await nativeBalance(updates[`${role}_PUBLIC`]);
    console.log(`  ${role.padEnd(8)} ${balance ?? (fund ? "NOT FOUND" : "n/a (not funded by design)")}`);
    if (fund && balance === null) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
