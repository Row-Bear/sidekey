import { useCallback, useEffect, useMemo, useState } from "react";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { KitEventType, Networks, type ModuleInterface } from "@creit.tech/stellar-wallets-kit/types";
import type { PendingSignature, SignatureResponse } from "@poc/core";
import type { BrowserSigner } from "./signing";
import { testWalletModules } from "./testWallet";

// Connecting a wallet through the Stellar Wallets Kit, and turning it into a one-click signer for the
// signing modal. Only the xBull and Freighter modules are bundled (plus a test wallet in dev).

const TESTNET = Networks.TESTNET;

/**
 * Wallets that cannot sign an authorization for a smart account, so they sign a SEP-53 message instead:
 * their kit module rejects `signAuthEntry` (read from the kit's source), or, like Freighter (found by
 * hand), the wallet only signs entries for its own G account and blocks ones for a C address.
 * Others are tried with `signAuthEntry` first.
 */
const MESSAGE_ONLY = new Set(["xbull", "freighter", "albedo", "lobstr", "hana", "rabet", "ledger", "trezor", "onekey", "bitget", "fordefi", "wallet_connect", "test-wallet-message"]);

let initialized = false;
function ensureKit(): void {
  if (initialized) return;
  const modules: ModuleInterface[] = [new xBullModule(), new FreighterModule(), ...testWalletModules()];
  StellarWalletsKit.init({ modules, network: TESTNET });
  initialized = true;
}

export type NetworkCheck = { kind: "testnet" } | { kind: "other"; passphrase: string } | { kind: "unknown" };

export interface WalletConnection {
  address: string;
  walletId: string;
  walletName: string;
  network: NetworkCheck;
}

/** Asks the wallet which network it is on, where it can say (xBull cannot). */
async function checkNetwork(): Promise<NetworkCheck> {
  try {
    const { networkPassphrase } = await StellarWalletsKit.getNetwork();
    return networkPassphrase === TESTNET ? { kind: "testnet" } : { kind: "other", passphrase: networkPassphrase };
  } catch {
    return { kind: "unknown" };
  }
}

const isUnsupported = (err: unknown): boolean =>
  /does not support|not support/i.test(String((err as { message?: string })?.message ?? err));

/** Signs whatever the server is waiting for with the connected wallet. */
export function walletSigner(connection: WalletConnection): BrowserSigner {
  const { address, walletId, walletName } = connection;
  const opts = { networkPassphrase: TESTNET, address };
  return {
    id: `wallet:${walletId}`,
    label: `Sign with ${walletName}`,
    appliesTo: (request: PendingSignature) => request.signer.address === address,
    async sign(request: PendingSignature): Promise<SignatureResponse> {
      if (request.kind === "transaction") {
        const { signedTxXdr } = await StellarWalletsKit.signTransaction(request.transactionXdr, {
          ...opts,
          networkPassphrase: request.networkPassphrase,
        });
        return { kind: "transaction", signedXdr: signedTxXdr };
      }
      const asMessage = async (): Promise<SignatureResponse> => {
        const { signedMessage } = await StellarWalletsKit.signMessage(request.message, opts);
        return { kind: "message", signature: signedMessage };
      };
      if (MESSAGE_ONLY.has(walletId)) return asMessage();
      try {
        const { signedAuthEntry } = await StellarWalletsKit.signAuthEntry(request.preimageXdr, opts);
        return { kind: "payload", signature: signedAuthEntry };
      } catch (err) {
        if (isUnsupported(err)) return asMessage();
        throw err;
      }
    },
  };
}

/** A readable message for the kit's thrown `{code, message}` objects. */
export function walletError(err: unknown): string {
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; code?: number } | null;
  return e?.message ? `${e.message}${e.code !== undefined ? ` (code ${e.code})` : ""}` : String(err);
}

/** The connected wallet, as React state, and the signers it provides. */
export function useWallet() {
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    ensureKit();
    const off = StellarWalletsKit.on(KitEventType.DISCONNECT, () => setConnection(null));
    return off;
  }, []);

  const connect = useCallback(async () => {
    ensureKit();
    setError(null);
    setConnecting(true);
    try {
      const { address } = await StellarWalletsKit.authModal();
      const module = StellarWalletsKit.selectedModule;
      setConnection({ address, walletId: module.productId, walletName: module.productName, network: await checkNetwork() });
    } catch (err) {
      // Closing the modal rejects too; only show real failures.
      const message = walletError(err);
      if (!/closed|cancel|reject/i.test(message)) setError(message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await StellarWalletsKit.disconnect().catch(() => {});
    setConnection(null);
  }, []);

  const signers = useMemo(() => (connection ? [walletSigner(connection)] : []), [connection]);
  return { connection, signers, connect, disconnect, connecting, error };
}
