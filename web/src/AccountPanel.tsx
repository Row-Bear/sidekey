import { useEffect, useState } from "react";
import { STATIC } from "./build";
import type { DemoState, RunRequest } from "./api-types";
import { accountUrl, loadWalletAccount, registerPasskey, shortAddress } from "./api";
import { CopyButton } from "./CopyButton";
import { Info } from "./Info";
import { createPasskey, passkeysSupported } from "./passkey";
import { Spinner } from "./Spinner";
import { useWalletAccounts } from "./useWalletAccounts";
import type { useWallet } from "./wallet";

type Wallet = ReturnType<typeof useWallet>;

const OTHER = "other";

/**
 * The plain page's account card: which smart account is active (pick, load, create, record it on the wallet) and
 * its delegate passkey, in a few lines. The wallet itself lives in the header chip.
 */
export function AccountPanel({ wallet, state, busy, version, onStart, onChanged }: {
  wallet: Wallet;
  state: DemoState;
  busy: boolean;
  /** Bumps when on-chain state may have changed. */
  version: number;
  onStart: (request: RunRequest) => void;
  onChanged: () => void;
}) {
  const { connection } = wallet;
  const { status, owned, currentId, currentRecorded, choices, wrongWallet, offTestnet, creating } = useWalletAccounts(connection, state, version);

  // The account chosen in the picker: the active one until the user picks another or "other" to paste an id.
  const [selected, setSelected] = useState("");
  const [pasted, setPasted] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [makingPasskey, setMakingPasskey] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  useEffect(() => setSelected(currentId), [currentId]);
  // A message about one wallet does not belong to the next.
  useEffect(() => setError(null), [connection?.address]);

  const toLoad = selected === OTHER ? pasted.trim() : selected;
  const loadable = toLoad !== "" && !(owned && toLoad === currentId);

  const load = async (address: string) => {
    setError(null);
    setLoading(true);
    try {
      await loadWalletAccount(address, toLoad);
      setPasted("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const createPasskeyNow = async () => {
    setMakingPasskey(true);
    setPasskeyError(null);
    try {
      await registerPasskey(await createPasskey());
      onChanged();
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setMakingPasskey(false);
    }
  };

  const passkey = state.passkey;
  const wrongSite = passkey !== null && passkey.rpId !== location.hostname;
  const supported = passkeysSupported();

  return (
    <section className="card account-card">
      <div className="section-head">
        <h2>
          Smart account{" "}
          <Info text="Holds the funds and checks every signature itself. Your wallet is its master and can do anything; a delegate can only do what its rules allow." />
        </h2>
        {currentId && !STATIC && (
          <span className={currentRecorded ? "tag ok" : "tag"} title="Recorded as a data entry on your wallet's own Stellar account, so any browser can find it">
            {currentRecorded ? "recorded on your wallet" : "not recorded on your wallet"}
          </span>
        )}
      </div>

      {!connection ? (
        <div className="empty-state">
          {state.mode === "wallet" && state.wallet ? (
            <p className="muted small">
              Active account <code title={state.wallet.smartAccountId}>{shortAddress(state.wallet.smartAccountId)}</code>{" "}
              <CopyButton text={state.wallet.smartAccountId} label="smart account id" /> belongs to{" "}
              <code title={state.wallet.address}>{shortAddress(state.wallet.address)}</code>. Connect that wallet to edit it.
            </p>
          ) : (
            <p className="muted small">Connect your wallet to create a smart account or load one you already have.</p>
          )}
          <button disabled={wallet.connecting} onClick={() => void wallet.connect()}>
            {wallet.connecting ? <Spinner label="Connecting…" /> : "Connect wallet"}
          </button>
        </div>
      ) : (
        <>
          {offTestnet && <p className="error small">Switch the wallet to testnet; this app only runs there.</p>}
          {wrongWallet && (
            <p className="error small">
              The active account belongs to {shortAddress(state.wallet!.address)}, not this wallet. Load one of yours below, or create a new one.
            </p>
          )}
          {status?.exists === false && (
            <p className="warn small">
              This wallet's account is not on testnet yet.{" "}
              <button type="button" className="ghost small-btn" disabled={busy || offTestnet} onClick={() => onStart({ action: "wallet-fund", address: connection.address })}>
                Fund with Friendbot
              </button>
            </p>
          )}

          <div className="actions">
            <select
              className="grow"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={busy || loading}
              aria-label="Smart account"
            >
              {selected === "" && <option value="">Select an account…</option>}
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {[shortAddress(c.id), c.id === currentId ? "active" : null, c.onChain ? null : c.id === currentId ? null : "this browser's list"].filter(Boolean).join(" · ")}
                </option>
              ))}
              <option value={OTHER}>Another account (paste a contract id)…</option>
            </select>
            {currentId && (
              <>
                <a href={accountUrl(currentId)} target="_blank" rel="noreferrer" className="small" title={currentId}>
                  View
                </a>
                <CopyButton text={currentId} label="smart account id" />
              </>
            )}
            {loadable && (
              <button disabled={busy || loading || offTestnet} onClick={() => void load(connection.address)}>
                {loading ? <Spinner label="Checking…" /> : "Load account"}
              </button>
            )}
          </div>
          {selected === OTHER && (
            <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Contract id (C…)" spellCheck={false} aria-label="Smart account contract id" />
          )}

          <div className="actions">
            <button
              className={owned ? "ghost" : undefined}
              disabled={busy || offTestnet}
              title="Deploys a new smart account with your wallet as its master"
              onClick={() => onStart({ action: "wallet-account", address: connection.address })}
            >
              {creating ? <Spinner label="Creating smart account…" /> : owned ? "New smart account" : "Create smart account"}
            </button>
            {owned && !currentRecorded && !STATIC && (
              <button
                className="ghost"
                disabled={busy || offTestnet}
                title="One wallet-signed transaction that adds a data entry to your Stellar account (0.5 XLM reserve) so any browser can find this account"
                onClick={() => onStart({ action: "record-account", address: connection.address })}
              >
                Record on my wallet
              </button>
            )}
          </div>
          {(error || wallet.error) && <p className="error small">{error ?? wallet.error}</p>}
        </>
      )}

      <div className="delegate-row">
        <span className="field-label">
          Delegate{" "}
          <Info text="A passkey on this device. Each of its calls asks for your fingerprint, PIN or security key, and the smart account checks the WebAuthn signature itself. You can also register any G address as a signer in the policy editor." />
        </span>
        {passkey ? (
          <span>
            Passkey <code title={passkey.publicKeyHex}>{passkey.publicKeyHex.slice(2, 10)}…</code> for <code>{passkey.rpId}</code>
            {wrongSite && <span className="error"> (open the app at {passkey.rpId} to use it)</span>}
          </span>
        ) : (
          <span className="muted">No passkey yet</span>
        )}
        <button
          className={passkey ? "ghost" : undefined}
          disabled={busy || makingPasskey || !supported}
          title={supported ? undefined : "Passkeys need https or localhost"}
          onClick={() => void createPasskeyNow()}
        >
          {makingPasskey ? "Waiting for your device…" : passkey ? "Create a new passkey" : "Create passkey"}
        </button>
      </div>
      {passkeyError && <p className="error small">{passkeyError}</p>}
    </section>
  );
}
