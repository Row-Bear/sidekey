// Smart accounts made by the on-chain factory (`contracts/factory`). The factory's `create` is an ordinary contract
// call the master authorizes as the source of its own transaction, so any wallet can sign it and a relayer can pay.
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { type ChainContext, invokeAsSource, type InvokeResult, read } from "./chain.js";

/** How many accounts per master are looked for (index 0 is the first). */
export const MAX_FACTORY_ACCOUNTS = 8;

const indexScVal = (index: number): xdr.ScVal => nativeToScVal(index, { type: "u32" });

/** Where the master's `index`-th account is (or will be) deployed; the factory computes it, nothing is sent. */
export async function factoryAccountAddress(ctx: ChainContext, factoryId: string, master: string, index: number): Promise<string> {
  return (await read(ctx, factoryId, "account_address", [new Address(master).toScVal(), indexScVal(index)])) as string;
}

export interface FactoryAccount {
  index: number;
  smartAccountId: string;
}

const instanceKey = (contractId: string): xdr.LedgerKey =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );

/**
 * The accounts the factory has deployed for this master, found from the addresses it would use (no list is kept
 * anywhere). Every slot up to `max` is checked, so a gap in the numbering does not hide later accounts.
 */
export async function findFactoryAccounts(ctx: ChainContext, factoryId: string, master: string, max = MAX_FACTORY_ACCOUNTS): Promise<FactoryAccount[]> {
  const candidates = await Promise.all(
    Array.from({ length: max }, async (_, index) => ({ index, smartAccountId: await factoryAccountAddress(ctx, factoryId, master, index) })),
  );
  const { entries } = await ctx.server.getLedgerEntries(...candidates.map((c) => instanceKey(c.smartAccountId)));
  const found = new Set(entries.map((e) => (e.key.type === "contractData" ? Address.fromScAddress(e.key.contractData.contract).toString() : "")));
  return candidates.filter((c) => found.has(c.smartAccountId));
}

export interface CreateAccountOptions {
  ctx: ChainContext;
  factoryId: string;
  /** The wallet's G address: the smart account's master, and the source of the transaction it signs. */
  master: string;
  /** The first unused number from `findFactoryAccounts`. */
  index: number;
  signTransaction: (unsignedXdr: string, summary: string[]) => Promise<string>;
}

/** Deploys the master's `index`-th smart account through the factory. */
export async function createAccountViaFactory({ ctx, factoryId, master, index, signTransaction }: CreateAccountOptions): Promise<InvokeResult> {
  return invokeAsSource(ctx, {
    contractId: factoryId,
    method: "create",
    args: [new Address(master).toScVal(), indexScVal(index)],
    sourceAddress: master,
    signTransaction,
  });
}
