// Node-only: filesystem and Friendbot.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Account, Address, Contract, Keypair, rpc, scValToNative, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { FRIENDBOT_URL, NATIVE_TOKEN_ID, NETWORK_PASSPHRASE, requireEnv } from "./config.js";
import { deploySmartAccount } from "./deploy.js";
import { setEnvValues } from "./envfile.js";
import { saveSession } from "./session.js";

export const WASM_RELATIVE_PATH = "target/wasm32v1-none/release/smart_account.wasm";

export async function fundWithFriendbot(publicKey: string): Promise<void> {
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

/** Whether a G account exists on testnet, and its XLM balance in stroops when it does. */
export async function accountStatus(rpcUrl: string, address: string): Promise<{ exists: false } | { exists: true; stroops: bigint }> {
  const server = new rpc.Server(rpcUrl);
  try {
    await server.getAccount(address);
  } catch {
    return { exists: false };
  }
  const tx = new TransactionBuilder(new Account(address, "0"), { fee: "100", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(NATIVE_TOKEN_ID).call("balance", new Address(address).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) throw new Error("Could not read the account's XLM balance");
  return { exists: true, stroops: BigInt(scValToNative(sim.result.retval) as bigint) };
}

export interface WalletAccountOptions {
  repoRoot: string;
  sessionPath: string;
  /** The connected wallet's G address, which becomes the smart account's master. */
  masterAddress: string;
  log?: (message: string) => void;
}

/**
 * Deploys a new smart account whose master is a wallet's address, and switches the session to wallet
 * mode. The sponsor pays; the wallet is not asked for anything, and no secret is stored.
 */
export async function createWalletAccount({ repoRoot, sessionPath, masterAddress, log = () => {} }: WalletAccountOptions) {
  if (!StrKey.isValidEd25519PublicKey(masterAddress)) throw new Error(`"${masterAddress}" is not a Stellar G address`);
  const wasmPath = join(repoRoot, WASM_RELATIVE_PATH);
  if (!existsSync(wasmPath)) throw new Error(`Contract wasm not found; run "npm run build:contract" first (${wasmPath})`);

  log(`Deploying a smart account whose master is the wallet ${masterAddress}`);
  const { contractId } = deploySmartAccount({ sponsorSecret: requireEnv("SPONSOR_SECRET"), masterPublic: masterAddress, wasmPath, cwd: repoRoot });
  const wallet = { address: masterAddress, smartAccountId: contractId };
  saveSession(sessionPath, { mode: "wallet", wallet });
  log(`Smart account ${contractId} deployed`);
  return wallet;
}
