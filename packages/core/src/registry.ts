// Remembering a wallet's smart accounts on chain: each account is a classic data entry on the master's own
// G account (`smart_account_1`, `smart_account_2`, ...) whose value is the contract id. Only the master can
// write them (its signature on an ordinary transaction), anyone can read them, and each costs 0.5 XLM of
// the master's reserve. Stellar RPC reads data entries by exact key, so the keys are numbered and a fixed
// range is read in one request.
import { Keypair, Operation, StrKey, type Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { type ChainContext, submitAndWait } from "./chain.js";
import { NETWORK_PASSPHRASE } from "./config.js";

export const DATA_KEY_PREFIX = "smart_account_";
/** How many accounts one wallet can record (32 entries is 16 XLM of reserve). */
export const MAX_RECORDED_ACCOUNTS = 32;

export const dataKeyName = (index: number): string => `${DATA_KEY_PREFIX}${index}`;

export interface RecordedAccount {
  /** The number in the key name, starting at 1. */
  index: number;
  smartAccountId: string;
}

/** The lowest unused number, or null when every slot is taken. */
export function nextFreeIndex(recorded: readonly RecordedAccount[]): number | null {
  const used = new Set(recorded.map((r) => r.index));
  for (let i = 1; i <= MAX_RECORDED_ACCOUNTS; i++) if (!used.has(i)) return i;
  return null;
}

/** A data entry's key and value, turned into a recorded account if it is one of ours (other entries are ignored). */
export function parseRecordedEntry(name: string, value: Uint8Array): RecordedAccount | null {
  const match = new RegExp(`^${DATA_KEY_PREFIX}([1-9][0-9]*)$`).exec(name);
  if (!match) return null;
  const index = Number(match[1]);
  const smartAccountId = Buffer.from(value).toString("utf8");
  if (index > MAX_RECORDED_ACCOUNTS || !StrKey.isValidContract(smartAccountId)) return null;
  return { index, smartAccountId };
}

/** The smart accounts recorded on a G account, in key order. Valid entries only; the account's `master()` is still checked on load. */
export async function readRecordedAccounts(ctx: ChainContext, address: string): Promise<RecordedAccount[]> {
  const accountId = Keypair.fromPublicKey(address).xdrAccountId();
  const keys = Array.from({ length: MAX_RECORDED_ACCOUNTS }, (_, i) =>
    xdr.LedgerKey.data(new xdr.LedgerKeyData({ accountId, dataName: dataKeyName(i + 1) })),
  );
  const { entries } = await ctx.server.getLedgerEntries(...keys);
  const recorded: RecordedAccount[] = [];
  for (const entry of entries) {
    if (entry.val.type !== "data") continue;
    const { dataName, dataValue } = entry.val.data;
    const parsed = parseRecordedEntry(Buffer.from(dataName.bytes).toString("utf8"), dataValue.value);
    if (parsed) recorded.push(parsed);
  }
  return recorded.sort((a, b) => a.index - b.index);
}

export interface RecordAccountOptions {
  ctx: ChainContext;
  /** The wallet's G address: the transaction source, which pays the fee and holds the entry. */
  masterAddress: string;
  smartAccountId: string;
  /** Gets the transaction signed by the wallet; resolves to the signed envelope XDR. */
  signTransaction: (unsignedXdr: string, summary: string[]) => Promise<string>;
}

export type RecordAccountResult = { status: "already"; index: number } | { status: "recorded"; index: number; hash: string };

/** Writes the account into the first free `smart_account_N` entry, unless it is already recorded. */
export async function recordAccount({ ctx, masterAddress, smartAccountId, signTransaction }: RecordAccountOptions): Promise<RecordAccountResult> {
  if (!StrKey.isValidEd25519PublicKey(masterAddress)) throw new Error(`"${masterAddress}" is not a Stellar G address`);
  if (!StrKey.isValidContract(smartAccountId)) throw new Error(`"${smartAccountId}" is not a contract id (C…)`);

  const recorded = await readRecordedAccounts(ctx, masterAddress);
  const existing = recorded.find((r) => r.smartAccountId === smartAccountId);
  if (existing) return { status: "already", index: existing.index };
  const index = nextFreeIndex(recorded);
  if (index === null) throw new Error(`This wallet already records ${MAX_RECORDED_ACCOUNTS} smart accounts, the most it can`);

  const name = dataKeyName(index);
  const tx = new TransactionBuilder(await ctx.server.getAccount(masterAddress), { fee: "1000", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.manageData({ name, value: smartAccountId }))
    .setTimeout(300)
    .build();
  const signedXdr = await signTransaction(tx.toXDR(), [`Record smart account ${smartAccountId} on your account as ${name}`]);
  const result = await submitAndWait(ctx.server, TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE) as Transaction);
  if (!result.ok) {
    throw new Error(`${result.error}. Each recorded account needs 0.5 XLM of extra reserve on the wallet's account, so check its balance.`);
  }
  return { status: "recorded", index, hash: result.hash };
}
