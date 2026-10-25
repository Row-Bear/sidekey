import "dotenv/config";
import { fileURLToPath } from "node:url";
import { deploySmartAccount, requireEnv, setEnvValues, WASM_RELATIVE_PATH } from "@poc/core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_PATH = new URL("../.env", import.meta.url);

function main(): void {
  if (process.env.SMART_ACCOUNT_ID && !process.argv.includes("--force")) {
    console.log(`SMART_ACCOUNT_ID already set (${process.env.SMART_ACCOUNT_ID}); pass --force to deploy a new one.`);
    return;
  }

  const { contractId, masterHex } = deploySmartAccount({
    sponsorSecret: requireEnv("SPONSOR_SECRET"),
    masterPublic: requireEnv("MASTER_PUBLIC"),
    wasmPath: WASM_RELATIVE_PATH,
    cwd: ROOT,
  });

  setEnvValues(ENV_PATH, { SMART_ACCOUNT_ID: contractId });
  console.log(`Smart account deployed: ${contractId}`);
  console.log(`Master signer (ed25519): ${masterHex}`);
}

main();
