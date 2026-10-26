import { Keypair, TransactionBuilder, hash } from "@stellar/stellar-sdk";
import { ModuleType, type ModuleInterface } from "@creit.tech/stellar-wallets-kit/types";

// A test wallet for the dev server, registered with the Wallets Kit like a real one, so the whole
// path (kit, signing modal, broker, contract) can be exercised without a browser extension. It holds
// a testnet key in sessionStorage and asks `confirm()` before signing, showing what a wallet shows.
// It is not part of a production build.

const STORAGE_KEY = "poc.testWallet.secret";
const SEP53_PREFIX = "Stellar Signed Message:\n";
// xBull reads a message as base64 when it looks like base64 and as UTF-8 otherwise.
const XBULL_BASE64 = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;

const ICON = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#6ea8fe"/><text x="16" y="22" font-size="17" text-anchor="middle" fill="#0d1117" font-family="sans-serif" font-weight="700">T</text></svg>');

function keypair(): Keypair {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (stored) return Keypair.fromSecret(stored);
  const created = Keypair.random();
  sessionStorage.setItem(STORAGE_KEY, created.secret());
  return created;
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function approve(question: string): void {
  if (!window.confirm(`Test wallet: ${question}`)) throw { code: -4, message: "The user rejected the request" };
}

const unsupported = (what: string) => ({ code: -3, message: `This test wallet does not support the "${what}" function` });

function makeModule(id: string, name: string, supportsAuthEntry: boolean): ModuleInterface {
  return {
    moduleType: ModuleType.HOT_WALLET,
    productId: id,
    productName: name,
    productUrl: "http://localhost:5173",
    productIcon: ICON,
    isAvailable: async () => true,
    getAddress: async () => ({ address: keypair().publicKey() }),

    async signTransaction(xdr, opts) {
      const tx = TransactionBuilder.fromXDR(xdr, opts?.networkPassphrase ?? "");
      approve(`sign this transaction?\n\nsource ${"source" in tx ? tx.source : ""}\nhash ${toBase64(tx.hash()).slice(0, 16)}…`);
      tx.sign(keypair());
      return { signedTxXdr: tx.toXDR(), signerAddress: keypair().publicKey() };
    },

    async signAuthEntry(authEntry) {
      if (!supportsAuthEntry) throw unsupported("signAuthEntry");
      approve(`sign this authorization entry?\n\n${authEntry.slice(0, 96)}…`);
      return { signedAuthEntry: toBase64(keypair().sign(hash(fromBase64(authEntry)))), signerAddress: keypair().publicKey() };
    },

    async signMessage(message) {
      approve(`sign this message?\n\n${message}`);
      // xBull's reading of the message (base64 heuristic) versus strict SEP-53 (always UTF-8).
      const body = !supportsAuthEntry && XBULL_BASE64.test(message) ? fromBase64(message) : utf8(message);
      const full = new Uint8Array([...utf8(SEP53_PREFIX), ...body]);
      return { signedMessage: toBase64(keypair().sign(hash(full))), signerAddress: keypair().publicKey() };
    },

    async getNetwork() {
      if (!supportsAuthEntry) throw unsupported("getNetwork");
      return { network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" };
    },
  };
}

/** Two test wallets sharing one key: xBull-like (messages only) and Freighter-like (auth entries). */
export function testWalletModules(): ModuleInterface[] {
  if (!import.meta.env.DEV) return [];
  return [
    makeModule("test-wallet-message", "Test wallet (like xBull)", false),
    makeModule("test-wallet-auth-entry", "Test wallet (like Freighter)", true),
  ];
}
