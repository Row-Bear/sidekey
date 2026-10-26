import { useEffect, useState } from "react";
import type { DemoState, RunRequest } from "./api-types";
import { accountUrl, fetchRecordedAccounts, fetchWalletStatus, formatXlm, loadWalletAccount, setMasterMode, shortAddress, type WalletStatus } from "./api";
import type { useWallet } from "./wallet";

type Wallet = ReturnType<typeof useWallet>;

function NetworkChip({ network }: { network: NonNullable<Wallet["connection"]>["network"] }) {
  if (network.kind === "testnet") return <span className="tag ok">testnet</span>;
  if (network.kind === "other") return <span className="tag expired" title={network.passphrase}>not on testnet</span>;
  return <span className="tag" title="This wallet cannot report its network; requests are sent with the testnet passphrase.">network unknown</span>;
}

/** Connect a wallet, make it the master of a smart account, and switch between it and the demo keys. */
export function WalletPanel({ wallet, state, busy, version, onStart, onChanged }: {
  wallet: Wallet;
  state: DemoState;
  busy: boolean;
  /** Bumps when on-chain state may have changed, so the balance refreshes. */
  version: number;
  onStart: (request: RunRequest) => void;
  onChanged: () => void;
}) {
  const { connection } = wallet;
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string[]>([]);
  const [accountId, setAccountId] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!connection) return setStatus(null);
    let cancelled = false;
    fetchWalletStatus(connection.address)
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, [connection?.address, version]);

  // A message about one wallet does not belong to the next.
  useEffect(() => setError(null), [connection?.address]);

  // Accounts the wallet's own account records on chain; they follow the wallet to any browser.
  useEffect(() => {
    if (!connection) return setRecorded([]);
    let cancelled = false;
    fetchRecordedAccounts(connection.address)
      .then((r) => !cancelled && setRecorded(r.accounts.map((a) => a.smartAccountId)))
      .catch(() => !cancelled && setRecorded([]));
    return () => {
      cancelled = true;
    };
  }, [connection?.address, version]);

  const switchMode = async (mode: "demo" | "wallet") => {
    setError(null);
    try {
      await setMasterMode(mode);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadAccount = async (address: string) => {
    setError(null);
    setLoading(true);
    try {
      await loadWalletAccount(address, accountId.trim());
      setAccountId("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const owned = connection !== null && state.wallet?.address === connection.address;
  const currentRecorded = state.wallet !== null && recorded.includes(state.wallet.smartAccountId);
  // On-chain entries first, then the ones only this dashboard remembers.
  const choices = connection
    ? [
        ...recorded.map((id) => ({ id, onChain: true })),
        ...state.knownAccounts.filter((a) => a.address === connection.address && !recorded.includes(a.smartAccountId)).map((a) => ({ id: a.smartAccountId, onChain: false })),
      ]
    : [];
  const wrongWallet = state.mode === "wallet" && state.wallet !== null && connection !== null && state.wallet.address !== connection.address;
  const offTestnet = connection?.network.kind === "other";

  return (
    <section className="card wallet-panel">
      <div className="section-head">
        <h2>Master signer</h2>
        <div className="mode-switch" role="group" aria-label="Master mode">
          <button className={state.mode === "demo" ? "tab active" : "tab"} disabled={busy || state.mode === "demo"} onClick={() => void switchMode("demo")}>
            Demo keys
          </button>
          <button
            className={state.mode === "wallet" ? "tab active" : "tab"}
            disabled={busy || state.mode === "wallet" || !state.wallet}
            title={state.wallet ? undefined : "Connect a wallet and create a smart account first"}
            onClick={() => void switchMode("wallet")}
          >
            My wallet
          </button>
        </div>
      </div>

      <p className="muted small">
        {state.mode === "wallet"
          ? "The master is your wallet: its signatures are made in the wallet and the server never sees its key. Every master action asks for a signature."
          : "The master is a key this demo holds, so everything runs without prompts. Connect a wallet to be the master yourself."}
      </p>

      {!connection ? (
        <div className="actions">
          <button disabled={wallet.connecting} onClick={() => void wallet.connect()}>
            {wallet.connecting ? "Connecting…" : "Connect wallet"}
          </button>
          <span className="muted small">xBull, Freighter{import.meta.env.DEV ? " or the dev test wallets" : ""}.</span>
        </div>
      ) : (
        <>
          <div className="wallet-line">
            <strong>{connection.walletName}</strong>
            <a href={accountUrl(connection.address)} target="_blank" rel="noreferrer" title={connection.address}>
              {shortAddress(connection.address)}
            </a>
            <NetworkChip network={connection.network} />
            {status?.exists === true && <span className="muted small">{formatXlm(status.stroops)} XLM</span>}
            {status?.exists === false && <span className="muted small">not on testnet yet</span>}
          </div>

          {offTestnet && <p className="error small">Switch the wallet to testnet; this demo only runs there.</p>}
          {wrongWallet && (
            <p className="error small">
              The master is {shortAddress(state.wallet!.address)}, not this wallet. Connect that wallet, or create a smart account for this one.
            </p>
          )}
          {owned && state.wallet && (
            <p className="muted small">
              Smart account <a href={accountUrl(state.wallet.smartAccountId)} target="_blank" rel="noreferrer">{shortAddress(state.wallet.smartAccountId)}</a> is owned by this wallet
              {currentRecorded ? " and recorded on its account." : "; it is not recorded on the wallet's account yet."}
            </p>
          )}

          <div className="field">
            <span className="field-label">Load an existing smart account of this wallet</span>
            <div className="actions">
              <input
                list="known-accounts"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="Pick one you used before, or paste a contract id (C…)"
                spellCheck={false}
                aria-label="Smart account contract id"
              />
              <datalist id="known-accounts">
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {[c.id === state.wallet?.smartAccountId ? "current" : shortAddress(c.id), c.onChain ? "on your account" : "this dashboard"].join(" · ")}
                  </option>
                ))}
              </datalist>
              <button className="ghost" disabled={busy || loading || offTestnet || accountId.trim() === ""} onClick={() => void loadAccount(connection.address)}>
                {loading ? "Checking…" : "Load account"}
              </button>
            </div>
            <span className="muted small">
              The account's master on chain must be this wallet; anything else is refused.{" "}
              {recorded.length > 0 && `${recorded.length} recorded on your account.`}
            </span>
          </div>

          <div className="actions">
            {status?.exists === false && (
              <button disabled={busy || offTestnet} onClick={() => onStart({ action: "wallet-fund", address: connection.address })}>
                Fund with Friendbot
              </button>
            )}
            <button className={owned ? "ghost" : undefined} disabled={busy || offTestnet} onClick={() => onStart({ action: "wallet-account", address: connection.address })}>
              {owned ? "New smart account for this wallet" : "Use this wallet as master"}
            </button>
            {owned && !currentRecorded && (
              <button
                className="ghost"
                disabled={busy || offTestnet}
                title="One wallet-signed transaction; adds a data entry smart_account_N to your account (0.5 XLM reserve)"
                onClick={() => onStart({ action: "record-account", address: connection.address })}
              >
                Record on my wallet
              </button>
            )}
            <button className="ghost" disabled={busy} onClick={() => void wallet.disconnect()}>
              Disconnect
            </button>
          </div>
        </>
      )}
      {(error || wallet.error) && <p className="error small">{error ?? wallet.error}</p>}
    </section>
  );
}
