import { useEffect, useState } from "react";
import type { DemoState, RunRequest } from "./api-types";
import { accountUrl, fetchRecordedAccounts, fetchWalletStatus, formatXlm, loadWalletAccount, setMasterMode, shortAddress, type WalletStatus } from "./api";
import { Spinner } from "./Spinner";
import type { useWallet } from "./wallet";

type Wallet = ReturnType<typeof useWallet>;

const OTHER = "other";

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
  // The account chosen in the picker: the active one until the user picks another or "other" to paste an id.
  const [selected, setSelected] = useState("");
  const [pasted, setPasted] = useState("");
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

  const loadAccount = async (address: string, smartAccountId: string) => {
    setError(null);
    setLoading(true);
    try {
      await loadWalletAccount(address, smartAccountId);
      setPasted("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const owned = connection !== null && state.wallet?.address === connection.address;
  const currentId = owned && state.wallet ? state.wallet.smartAccountId : "";
  const currentRecorded = currentId !== "" && recorded.includes(currentId);
  // The active account, then the other on-chain entries, then the ones only this dashboard remembers.
  const choices = connection
    ? [...new Set([...(currentId ? [currentId] : []), ...recorded, ...state.knownAccounts.filter((a) => a.address === connection.address).map((a) => a.smartAccountId)])].map((id) => ({
        id,
        onChain: recorded.includes(id),
      }))
    : [];
  const smartAccountToLoad = selected === OTHER ? pasted.trim() : selected;
  // Creating shows a spinner for as long as the server is deploying.
  const creating = busy && /^(Deploying|Creating)/.test(state.run.label ?? "");

  // The picker always shows the active account.
  useEffect(() => setSelected(currentId), [currentId]);
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

          <div className="field">
            <span className="field-label">Smart account of this wallet</span>
            <div className="actions">
              <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={busy || loading} aria-label="Smart account of this wallet">
                {selected === "" && <option value="">Select an account…</option>}
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {[
                      shortAddress(c.id),
                      c.id === currentId ? "active" : null,
                      c.onChain ? "on your account" : c.id === currentId ? "not recorded yet" : "this dashboard",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </option>
                ))}
                <option value={OTHER}>Another account (paste a contract id)…</option>
              </select>
              {currentId && (
                <a href={accountUrl(currentId)} target="_blank" rel="noreferrer" className="small" title={currentId}>
                  view active
                </a>
              )}
              <button
                className="ghost"
                disabled={busy || loading || offTestnet || smartAccountToLoad === "" || (owned && smartAccountToLoad === currentId)}
                onClick={() => void loadAccount(connection.address, smartAccountToLoad)}
              >
                {loading ? <Spinner label="Checking…" /> : "Load account"}
              </button>
            </div>
            {selected === OTHER && (
              <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Contract id (C…)" spellCheck={false} aria-label="Smart account contract id" />
            )}
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
              {creating ? <Spinner label="Creating smart account…" /> : owned ? "New smart account for this wallet" : "Use this wallet as master"}
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
