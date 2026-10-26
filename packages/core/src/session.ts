// Node-only: which master the dashboard is acting as. Demo mode uses the keys in `.env`; wallet mode
// uses a smart account whose master is the address of a connected wallet, with no secret stored.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { StrKey } from "@stellar/stellar-sdk";

export interface WalletAccount {
  /** The wallet's G address: the smart account's master. */
  address: string;
  smartAccountId: string;
}

export interface Session {
  mode: "demo" | "wallet";
  /** The most recent wallet account, kept when switching back to demo mode. */
  wallet?: WalletAccount;
}

const DEFAULT: Session = { mode: "demo" };

export function loadSession(path: string | URL): Session {
  if (!existsSync(path)) return { ...DEFAULT };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Session>;
  const wallet = parsed.wallet;
  const valid = wallet && StrKey.isValidEd25519PublicKey(wallet.address) && StrKey.isValidContract(wallet.smartAccountId);
  return { mode: parsed.mode === "wallet" && valid ? "wallet" : "demo", ...(valid ? { wallet } : {}) };
}

export function saveSession(path: string | URL, session: Session): void {
  writeFileSync(path, JSON.stringify(session, null, 2) + "\n");
}

/** Environment overrides that point a scenario context at the session's master. Empty in demo mode. */
export function sessionEnv(session: Session): Record<string, string> {
  if (session.mode !== "wallet" || !session.wallet) return {};
  return { MASTER_MODE: "wallet", MASTER_PUBLIC: session.wallet.address, SMART_ACCOUNT_ID: session.wallet.smartAccountId };
}
