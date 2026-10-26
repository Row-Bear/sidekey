import { useEffect, useState } from "react";
import type { DemoState } from "./api-types";
import { fetchRecordedAccounts, fetchWalletStatus, type WalletStatus } from "./api";
import type { WalletConnection } from "./wallet";

export interface AccountChoice {
  id: string;
  /** Recorded on the wallet's own Stellar account (so it follows the wallet to any browser). */
  onChain: boolean;
}

/**
 * What the connected wallet has: its balance, the smart accounts recorded on its account and remembered by this
 * dashboard, and how the active account relates to it. `version` bumps when on-chain state may have changed.
 */
export function useWalletAccounts(connection: WalletConnection | null, state: DemoState, version: number) {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [recorded, setRecorded] = useState<string[]>([]);
  const address = connection?.address;

  useEffect(() => {
    if (!address) return setStatus(null);
    let cancelled = false;
    fetchWalletStatus(address)
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, [address, version]);

  useEffect(() => {
    if (!address) return setRecorded([]);
    let cancelled = false;
    fetchRecordedAccounts(address)
      .then((r) => !cancelled && setRecorded(r.accounts.map((a) => a.smartAccountId)))
      .catch(() => !cancelled && setRecorded([]));
    return () => {
      cancelled = true;
    };
  }, [address, version]);

  const owned = connection !== null && state.wallet?.address === connection.address;
  const currentId = owned && state.wallet ? state.wallet.smartAccountId : "";
  // The active account, then the other on-chain entries, then the ones only this dashboard remembers.
  const choices: AccountChoice[] = connection
    ? [...new Set([...(currentId ? [currentId] : []), ...recorded, ...state.knownAccounts.filter((a) => a.address === connection.address).map((a) => a.smartAccountId)])].map(
        (id) => ({ id, onChain: recorded.includes(id) }),
      )
    : [];

  return {
    status,
    recorded,
    owned,
    currentId,
    currentRecorded: currentId !== "" && recorded.includes(currentId),
    choices,
    // The session is on a wallet account, but not this wallet's.
    wrongWallet: state.mode === "wallet" && state.wallet !== null && connection !== null && state.wallet.address !== connection.address,
    offTestnet: connection?.network.kind === "other",
    /** A smart account is being deployed. */
    creating: state.run.busy && /^(Deploying|Creating)/.test(state.run.label ?? ""),
  };
}
