// Reading and checking accounts on testnet; safe to use in a browser.
import { Account, Address, Contract, rpc, scValToNative, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { type ChainContext, read } from "./chain.js";
import { FRIENDBOT_URL, NATIVE_TOKEN_ID, NETWORK_PASSPHRASE } from "./config.js";

export async function fundWithFriendbot(publicKey: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
    if (res.ok) return;
    if (attempt >= 3) throw new Error(`Friendbot ${res.status}: ${await res.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
  }
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

/**
 * Checks on chain that `smartAccountId` is a smart account whose master is `masterAddress`; anything else (another
 * owner, or not a smart account) is refused. Returns the pair.
 */
export async function checkWalletAccount(ctx: ChainContext, masterAddress: string, smartAccountId: string) {
  if (!StrKey.isValidEd25519PublicKey(masterAddress)) throw new Error(`"${masterAddress}" is not a Stellar G address`);
  if (!StrKey.isValidContract(smartAccountId)) throw new Error(`"${smartAccountId}" is not a contract id (C…)`);

  let onChainMaster: unknown;
  try {
    onChainMaster = await read(ctx, smartAccountId, "master");
  } catch {
    throw new Error(`${smartAccountId} is not a smart account from this project (its master() could not be read)`);
  }
  // The contract returns its master as the raw 32-byte ed25519 key.
  if (!(onChainMaster instanceof Uint8Array) || onChainMaster.length !== 32) {
    throw new Error(`${smartAccountId} is not a smart account from this project (master() did not return a key)`);
  }
  if (!Buffer.from(onChainMaster).equals(StrKey.decodeEd25519PublicKey(masterAddress))) {
    throw new Error(`That smart account belongs to ${StrKey.encodeEd25519PublicKey(Buffer.from(onChainMaster))}, not to your wallet ${masterAddress}`);
  }

  return { address: masterAddress, smartAccountId };
}
