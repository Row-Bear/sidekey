import { useEffect, useRef, useState } from "react";
import type { DemoState, RunRequest } from "./api-types";
import { accountUrl, formatXlm, shortAddress } from "./api";
import { CopyButton } from "./CopyButton";
import { Spinner } from "./Spinner";
import { useWalletAccounts } from "./useWalletAccounts";
import type { useWallet } from "./wallet";

type Wallet = ReturnType<typeof useWallet>;

/** The wallet in the page header: a Connect button, or a chip with the wallet's name and address and a small menu. */
export function WalletChip({ wallet, state, busy, version, onStart }: {
  wallet: Wallet;
  state: DemoState;
  busy: boolean;
  version: number;
  onStart: (request: RunRequest) => void;
}) {
  const { connection } = wallet;
  const { status, offTestnet } = useWalletAccounts(connection, state, version);
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);

  // The menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!holder.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!connection) {
    return (
      <button disabled={wallet.connecting} onClick={() => void wallet.connect()}>
        {wallet.connecting ? <Spinner label="Connecting…" /> : "Connect wallet"}
      </button>
    );
  }

  const { network } = connection;
  return (
    <div className="menu" ref={holder}>
      <button type="button" className="chip-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`dot ${network.kind === "testnet" ? "ok" : network.kind === "other" ? "bad" : "warn"}`} aria-hidden="true" />
        {connection.walletName} · {shortAddress(connection.address)} ▾
      </button>
      {open && (
        <div className="menu-panel" role="menu">
          <div className="menu-row">
            <a href={accountUrl(connection.address)} target="_blank" rel="noreferrer" title={connection.address}>
              {shortAddress(connection.address)}
            </a>
            <CopyButton text={connection.address} label="wallet address" />
          </div>
          <div className="menu-row muted small">
            {network.kind === "testnet" && <span className="tag ok">testnet</span>}
            {network.kind === "other" && <span className="tag expired" title={network.passphrase}>not on testnet</span>}
            {network.kind === "unknown" && <span className="tag" title="This wallet cannot report its network; requests are sent with the testnet passphrase.">network unknown</span>}
            {status?.exists === true && <span>{formatXlm(status.stroops)} XLM</span>}
            {status?.exists === false && <span>not on testnet yet</span>}
          </div>
          {offTestnet && <p className="error small">Switch the wallet to testnet; this app only runs there.</p>}
          {status?.exists === false && (
            <button
              type="button"
              disabled={busy || offTestnet}
              onClick={() => {
                setOpen(false);
                onStart({ action: "wallet-fund", address: connection.address });
              }}
            >
              Fund with Friendbot
            </button>
          )}
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              void wallet.disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
