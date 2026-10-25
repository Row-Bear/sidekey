// Node-only: filesystem and Friendbot.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { FRIENDBOT_URL, requireEnv } from "./config.js";
import { deploySmartAccount } from "./deploy.js";
import { setEnvValues } from "./envfile.js";

export const WASM_RELATIVE_PATH = "target/wasm32v1-none/release/smart_account.wasm";

async function fundWithFriendbot(publicKey: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
    if (res.ok) return;
    if (attempt >= 3) throw new Error(`Friendbot ${res.status}: ${await res.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
}

export interface FreshAccountOptions {
  repoRoot: string;
  envPath: string;
  log?: (message: string) => void;
}

/**
 * Creates a new funded master G account and deploys a new smart account owned by it, then
 * points `.env` and the current process at them. The sponsor and delegate are reused.
 */
export async function createFreshDemoAccount({ repoRoot, envPath, log = () => {} }: FreshAccountOptions) {
  const wasmPath = join(repoRoot, WASM_RELATIVE_PATH);
  if (!existsSync(wasmPath)) throw new Error(`Contract wasm not found; run "npm run build:contract" first (${wasmPath})`);

  const master = Keypair.random();
  log(`Funding new master ${master.publicKey()} via Friendbot`);
  await fundWithFriendbot(master.publicKey());

  log("Deploying a new smart account with the new master as its default signer");
  const { contractId } = deploySmartAccount({
    sponsorSecret: requireEnv("SPONSOR_SECRET"),
    masterPublic: master.publicKey(),
    wasmPath,
    cwd: repoRoot,
  });

  // Persist the secret before anything else can fail, then update the live process.
  const values = { MASTER_PUBLIC: master.publicKey(), MASTER_SECRET: master.secret(), SMART_ACCOUNT_ID: contractId };
  setEnvValues(envPath, values);
  Object.assign(process.env, values);
  log(`Smart account ${contractId} deployed`);
  return { master: master.publicKey(), smartAccountId: contractId };
}
