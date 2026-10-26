// Node-only: shells out to the Stellar CLI.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StrKey } from "@stellar/stellar-sdk";

export interface DeployParams {
  sponsorSecret: string;
  masterPublic: string;
  wasmPath: string;
  cwd: string;
}

const execFileAsync = promisify(execFile);

/** Deploys without blocking the process, so the dashboard keeps answering while it runs (about 5 seconds). */
export async function deploySmartAccount({ sponsorSecret, masterPublic, wasmPath, cwd }: DeployParams): Promise<{
  contractId: string;
  masterHex: string;
}> {
  const masterHex = Buffer.from(StrKey.decodeEd25519PublicKey(masterPublic)).toString("hex");

  // The sponsor pays for the deployment; its secret is passed via env, not argv.
  const { stdout: output } = await execFileAsync(
    "stellar",
    ["contract", "deploy", "--wasm", wasmPath, "--network", "testnet", "--", "--master", masterHex],
    { cwd, env: { ...process.env, STELLAR_ACCOUNT: sponsorSecret }, encoding: "utf8" },
  );

  const contractId = output.trim().split(/\s+/).pop() ?? "";
  if (!StrKey.isValidContract(contractId)) {
    throw new Error(`Could not parse contract id from deploy output:\n${output}`);
  }
  return { contractId, masterHex };
}
