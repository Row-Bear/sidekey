// Node-only: which master the dashboard is acting as. Demo mode uses the keys in `.env`; wallet mode
// uses a smart account whose master is the address of a connected wallet, with no secret stored.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { StrKey } from "@stellar/stellar-sdk";

export interface WalletAccount {
  /** The wallet's G address: the smart account's master. */
  address: string;
  smartAccountId: string;
}

/** A passkey created in the browser to act as the delegate. */
export interface PasskeyDelegate {
  /** base64url credential id, so the browser can ask for exactly this passkey. */
  credentialId: string;
  /** The 65-byte uncompressed P-256 public key, hex. */
  publicKeyHex: string;
  /** The WebAuthn relying party id the passkey belongs to (the page's host name). */
  rpId: string;
}

export interface Session {
  mode: "demo" | "wallet";
  /** The most recent wallet account, kept when switching back to demo mode. */
  wallet?: WalletAccount;
  /** Who plays the delegate: the demo's own key, or a passkey. */
  delegate: "key" | "passkey";
  /** The passkey, kept when switching the delegate back to the key. */
  passkey?: PasskeyDelegate;
}

const DEFAULT: Session = { mode: "demo", delegate: "key" };

const isPasskey = (p: Partial<PasskeyDelegate> | undefined): p is PasskeyDelegate =>
  !!p && /^04[0-9a-f]{128}$/.test(p.publicKeyHex ?? "") && !!p.rpId && !!p.credentialId;

export function loadSession(path: string | URL): Session {
  if (!existsSync(path)) return { ...DEFAULT };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Session>;
  const wallet = parsed.wallet;
  const valid = wallet && StrKey.isValidEd25519PublicKey(wallet.address) && StrKey.isValidContract(wallet.smartAccountId);
  const passkey = isPasskey(parsed.passkey) ? parsed.passkey : undefined;
  return {
    mode: parsed.mode === "wallet" && valid ? "wallet" : "demo",
    ...(valid ? { wallet } : {}),
    delegate: parsed.delegate === "passkey" && passkey ? "passkey" : "key",
    ...(passkey ? { passkey } : {}),
  };
}

export function saveSession(path: string | URL, session: Session): void {
  writeFileSync(path, JSON.stringify(session, null, 2) + "\n");
}

/** Environment overrides that point a scenario context at the session's master. Empty in demo mode. */
export function sessionEnv(session: Session): Record<string, string> {
  const env: Record<string, string> = {};
  if (session.mode === "wallet" && session.wallet) {
    Object.assign(env, { MASTER_MODE: "wallet", MASTER_PUBLIC: session.wallet.address, SMART_ACCOUNT_ID: session.wallet.smartAccountId });
  }
  if (session.delegate === "passkey" && session.passkey) {
    Object.assign(env, { DELEGATE_PASSKEY_PUBLIC: session.passkey.publicKeyHex, DELEGATE_PASSKEY_RP: session.passkey.rpId });
  }
  return env;
}
