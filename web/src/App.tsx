import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CallRecord, RuleView, StepResult } from "@poc/core";
import type { DemoState, StepMeta } from "./api-types";
import {
  accountUrl,
  describeRule,
  expiryText,
  fetchState,
  formatXlm,
  selectDelegate,
  setMasterMode,
  shortAddress,
  startRun,
  stepStatus,
  type StepStatus,
} from "./api";
import { CallBuilder } from "./CallBuilder";
import { CallHistory } from "./CallHistory";
import { useAddressBook } from "./addressBook";
import { ContractPicker } from "./ContractPicker";
import { AccountPanel } from "./AccountPanel";
import { Toast } from "./Toast";
import { WalletChip } from "./WalletChip";
import { useContractFunctions, useSigners } from "./hooks";
import { PasskeyPanel } from "./PasskeyPanel";
import { passkeySigner } from "./passkey";
import { PolicyEditor } from "./PolicyEditor";
import { PolicyTable } from "./PolicyTable";
import { SigningModal } from "./SigningModal";
import { Spinner } from "./Spinner";
import { useWallet } from "./wallet";
import { WalletPanel } from "./WalletPanel";

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "Not run",
  running: "Running…",
  succeeded: "Succeeded",
  blocked: "Rejected by policy ✓",
  unexpected: "Unexpected result",
};

function AddressLink({ address, label }: { address: string; label?: string }) {
  if (!/^[GC][A-Z2-7]{55}$/.test(address)) return <span>{label ?? address}</span>;
  return (
    <a href={accountUrl(address)} target="_blank" rel="noreferrer" title={address}>
      {label ?? shortAddress(address)}
    </a>
  );
}

function Accounts({ state }: { state: DemoState }) {
  const { accounts } = state;
  const rows: [string, string, string][] = [
    ["Smart account", accounts.smartAccount, "Holds the funds; authorizes calls via its signing policy"],
    ["Master signer", accounts.master, "Default G-address signer, may authorize anything"],
    ["Delegate signer", accounts.delegate, "Policy-limited signer"],
    ["Fee sponsor", accounts.sponsor, "Submits transactions and pays all fees"],
    ["Yield simulator", accounts.simulator, "Simulated yield-bearing protocol"],
  ];
  return (
    <section className="card">
      <h2>Accounts</h2>
      <dl className="accounts">
        {rows.map(([name, address, description]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              <AddressLink address={address} />
              <span className="muted">{description}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Balances({ state }: { state: DemoState }) {
  const { snapshot } = state;
  const items: [string, string | undefined][] = [
    ["Smart account balance", snapshot ? formatXlm(snapshot.accountXlm) : undefined],
    ["Deposited in simulator", snapshot ? formatXlm(snapshot.deposited) : undefined],
    ["Accrued yield", snapshot ? formatXlm(snapshot.accruedYield) : undefined],
  ];
  return (
    <section className="card">
      <h2>Live balances</h2>
      <div className="balances">
        {items.map(([label, value]) => (
          <div key={label} className="balance">
            <span className="muted">{label}</span>
            <strong>{value ?? "—"}</strong>
            <span className="muted">XLM</span>
          </div>
        ))}
      </div>
      {state.readError && <p className="error">Could not read the chain: {state.readError}</p>}
    </section>
  );
}

function RuleLine({ rule, nameOf }: { rule: RuleView; nameOf: (id: string) => string }) {
  return (
    <li>
      <code>{describeRule(rule)}</code> on {nameOf(rule.contract)}
    </li>
  );
}

function ExpiryLine({ validUntil, latest }: { validUntil: number | null; latest: number | null }) {
  if (validUntil === null) return <span className="tag">no expiry</span>;
  if (latest === null) return <span className="tag">expires at ledger {validUntil.toLocaleString("en-US")}</span>;
  if (latest > validUntil) return <span className="tag expired">expired at ledger {validUntil.toLocaleString("en-US")}</span>;
  return <span className="tag">{expiryText(validUntil, latest)}</span>;
}

function Policy({ state, demo, nameOf }: { state: DemoState; demo: boolean; nameOf: (id: string) => string }) {
  const policy = state.delegatePolicy;
  const showDelegate = demo || state.delegate === "passkey";
  return (
    <section className="card">
      <h2>Signing policy</h2>
      <table>
        <thead>
          <tr>
            <th>Signer</th>
            <th>May authorize</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <span className="badge master" title="The master can authorize anything">master</span> <AddressLink address={state.accounts.master} />
            </td>
            <td>Any call (default signer, never expires)</td>
          </tr>
          {showDelegate && (
          <tr>
            <td>
              <span className="badge delegate" title="A delegate can only do what its rules allow">delegate</span> <AddressLink address={state.accounts.delegate} />
            </td>
            <td>
              {policy === null ? (
                <span className="muted">{demo ? "Not registered yet (step 1 sets the policy)" : "Not registered yet (add a rule in the policy editor)"}</span>
              ) : (
                <>
                  <ExpiryLine validUntil={policy.validUntilLedger} latest={state.latestLedger} />
                  {policy.rules.length === 0 ? (
                    <div className="muted">Nothing</div>
                  ) : (
                    <ul>
                      {policy.rules.map((rule) => (
                        <RuleLine
                          key={`${rule.contract}.${rule.function}.${rule.args.map((a) => a.kind).join()}`}
                          rule={rule}
                          nameOf={nameOf}
                        />
                      ))}
                    </ul>
                  )}
                </>
              )}
              {demo && <span className="muted small">Everything else, including withdraw(), is refused.</span>}
            </td>
          </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function Delta({ before, after }: { before: string; after: string }) {
  return before === after ? <>{formatXlm(after)}</> : <>{formatXlm(before)} → {formatXlm(after)}</>;
}

function StepCard({ meta, result, running, busy, onRun }: {
  meta: StepMeta;
  result: StepResult | undefined;
  running: boolean;
  busy: boolean;
  onRun: () => void;
}) {
  const status = stepStatus(result, running);
  return (
    <li className={`step ${status}`}>
      <div className="step-head">
        <span className="step-n">{meta.n}</span>
        <div className="step-title">
          <strong>{meta.name}</strong>
          <span className="muted small">
            <span className={`badge ${meta.signer}`}>{meta.signer}</span>
            expected: {meta.expected === "success" ? "succeeds" : "rejected"}
          </span>
        </div>
        <span className={`status ${status}`}>{STATUS_LABEL[status]}</span>
        <button className="ghost" disabled={busy} onClick={onRun}>
          Run
        </button>
      </div>
      {result && (
        <div className="step-body">
          {result.note && <div className="muted small">{result.note}</div>}
          {result.explorerUrl && (
            <a href={result.explorerUrl} target="_blank" rel="noreferrer">
              View transaction {result.txHash?.slice(0, 10)}…
            </a>
          )}
          {result.error && (
            <div className={status === "blocked" ? "rejection" : "error"}>
              {status === "blocked" ? "Blocked before submission: " : ""}
              {result.error}
            </div>
          )}
          <div className="muted small">
            Smart account <Delta before={result.before.accountXlm} after={result.after.accountXlm} /> · deposited{" "}
            <Delta before={result.before.deposited} after={result.after.deposited} /> · yield{" "}
            <Delta before={result.before.accruedYield} after={result.after.accruedYield} />
          </div>
        </div>
      )}
    </li>
  );
}

/** `demo` is the guided demo page (/demo); `mvp` is the plain policy and call tester on a wallet's account. */
export type Variant = "demo" | "mvp";

export default function App({ variant }: { variant: Variant }) {
  const demo = variant === "demo";
  const [state, setState] = useState<DemoState | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Reloads the state; resolves to whether a run is in progress (false when it could not be read). */
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const next = await fetchState();
      setState(next);
      setError(null);
      return next.run.busy;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, []);

  const busy = state?.run.busy ?? false;
  // The plain page has nothing to act on until a wallet's smart account is active.
  const ready = state?.mode === "wallet";

  // The outcome of each finished call or policy edit appears as a toast, so it is seen where the action was taken.
  const [toast, setToast] = useState<CallRecord | null>(null);
  const lastCallId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!state) return;
    const latest = state.calls[0] ?? null;
    if (lastCallId.current === undefined) {
      lastCallId.current = latest?.id ?? null; // what is already there on load is not news
      return;
    }
    if ((latest?.id ?? null) !== lastCallId.current) {
      lastCallId.current = latest?.id ?? null;
      setToast(latest);
    }
  }, [state]);
  const dismissToast = useCallback(() => setToast(null), []);
  // Which header button started the current run, so only that one shows it is working (set at the click,
  // before the server reports busy).
  const [started, setStarted] = useState<string | null>(null);

  // On-chain signers and policy change when a job finishes, so reload them then.
  const [signersVersion, setSignersVersion] = useState(0);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      setSignersVersion((v) => v + 1);
      setStarted(null);
    }
    wasBusy.current = busy;
  }, [busy]);
  const { data: signersData, error: signersError } = useSigners(signersVersion, demo);
  const book = useAddressBook(signersData);
  // One contract for both the policy editor and the call builder; the simulator is the starting choice.
  const [contract, setContract] = useState("");
  const defaultedContract = useRef(false);
  useEffect(() => {
    if (signersData && !defaultedContract.current) {
      defaultedContract.current = true;
      setContract(signersData.simulator);
    }
  }, [signersData]);
  const contractFunctions = useContractFunctions(contract);
  const wallet = useWallet();
  // Policy edits and master calls need the wallet that owns the account; the guided demo can use its own keys.
  const walletOwns = state?.mode === "wallet" && wallet.connection !== null && state.wallet?.address === wallet.connection.address;
  const canEdit = demo || walletOwns;
  const passkey = state?.passkey ?? null;
  const signers = useMemo(() => [...wallet.signers, ...(passkey ? [passkeySigner(passkey)] : [])], [wallet.signers, passkey]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), busy ? 1000 : 6000);
    return () => clearInterval(timer);
  }, [refresh, busy]);

  // The session is shared with the guided demo. The plain page works on a wallet's smart account with the passkey as
  // its delegate, so it switches back to those if the demo left something else, once per situation.
  const adjusted = useRef("");
  useEffect(() => {
    if (demo || !state || busy) return;
    const fix = state.mode === "demo" && state.wallet ? "wallet" : state.delegate === "key" && state.passkey ? "passkey" : null;
    if (fix === null) {
      adjusted.current = "";
      return;
    }
    const situation = `${fix}:${state.wallet?.smartAccountId}:${state.passkey?.publicKeyHex}`;
    if (adjusted.current === situation) return;
    adjusted.current = situation;
    (fix === "wallet" ? setMasterMode("wallet") : selectDelegate("passkey"))
      .then(() => {
        void refresh();
        setSignersVersion((v) => v + 1);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [demo, state, busy, refresh]);

  const start = async (request: Parameters<typeof startRun>[0]) => {
    setStarted(request.action);
    try {
      await startRun(request);
      // A run that already finished (or failed at once) must not leave its button spinning.
      if (!(await refresh())) setStarted(null);
    } catch (err) {
      setStarted(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const renderStep = (meta: StepMeta) => (
    <StepCard
      key={meta.n}
      meta={meta}
      result={state?.results[String(meta.n)]}
      running={state?.run.currentStep === meta.n}
      busy={busy}
      onRun={() => void start({ action: "steps", from: meta.n, to: meta.n })}
    />
  );

  // The wallet (master) and passkey (delegate) panels: two cards in the demo, one box on the plain page.
  const renderTopPanels = (current: DemoState, embedded: boolean) => (
    <>
      <WalletPanel
        embedded={embedded}
        demo={demo}
        wallet={wallet}
        state={current}
        busy={busy}
        version={signersVersion}
        onStart={(request) => void start(request)}
        onChanged={() => {
          void refresh();
          setSignersVersion((v) => v + 1);
        }}
      />
      <PasskeyPanel
        embedded={embedded}
        demo={demo}
        state={current}
        busy={busy}
        onChanged={() => {
          void refresh();
          setSignersVersion((v) => v + 1);
        }}
      />
    </>
  );

  return (
    <main>
      <header>
        <div>
          <h1>
            Stellar Smart Account PoC
            {!demo && <span className="tag ok" title="This app only works on the Stellar test network">testnet</span>}
          </h1>
          <p className="muted">
            {demo
              ? "A Soroban smart account with a default G-address signer and a policy that lets a delegate call only specific functions on specific contracts. Stellar testnet."
              : "Own a smart account with your wallet, give a delegate limited permissions, and try calls."}
          </p>
        </div>
        <div className="controls">
          {demo && (
            <>
              <button disabled={busy} onClick={() => void start({ action: "full" })}>
                {started === "full" ? <Spinner label="Running…" /> : busy ? "Running…" : "Run full demo"}
              </button>
              <button className="ghost" disabled={busy} onClick={() => void start({ action: "fresh" })}>
                {started === "fresh" ? <Spinner label="Creating…" /> : "New account only"}
              </button>
            </>
          )}
          <a className="nav-link" href={demo ? "/" : "/demo"}>
            {demo ? "← Policy tester" : "Guided demo →"}
          </a>
          {!demo && state && (
            <WalletChip wallet={wallet} state={state} busy={busy} version={signersVersion} onStart={(request) => void start(request)} />
          )}
        </div>
      </header>

      {error && <p className="error banner">{error}</p>}
      {!state ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {state.run.label && <p className="banner running">{state.run.label}</p>}
          {state.run.lastError && <p className="error banner">{state.run.lastError}</p>}
          {demo ? (
            renderTopPanels(state, false)
          ) : (
            <AccountPanel
              wallet={wallet}
              state={state}
              busy={busy}
              version={signersVersion}
              onStart={(request) => void start(request)}
              onChanged={() => {
                void refresh();
                setSignersVersion((v) => v + 1);
              }}
            />
          )}
          {(demo || ready) && (
            <>
          <div className="grid">
            {demo && <Accounts state={state} />}
            {/* On the plain page the policy sits on the left, directly above the policy editor. */}
            {demo ? (
              <>
                <Balances state={state} />
                <Policy state={state} demo={demo} nameOf={book.nameOf} />
              </>
            ) : (
              <PolicyTable
                data={signersData}
                canEdit={canEdit}
                busy={busy}
                nameOf={book.nameOf}
                onApply={(op) => void start({ action: "policy", policy: op, via: "browser" })}
              />
            )}
          </div>

          {signersError && <p className="error banner">{signersError}</p>}
          <section className="card contract-card">
            <ContractPicker value={contract} onChange={setContract} book={book} error={contractFunctions.error} />
          </section>
          <div className="grid2">
            {canEdit ? (
              <PolicyEditor demo={demo} compact={!demo} data={signersData} busy={busy} contract={contract} functions={contractFunctions.functions} loading={contractFunctions.loading} nameOf={book.nameOf} onApply={(policy, via) => void start({ action: "policy", policy, via })} />
            ) : (
              <section className="card">
                <h2>Policy editor</h2>
                <p className="muted small">
                  {wallet.connection
                    ? `This smart account belongs to ${state.wallet ? shortAddress(state.wallet.address) : "another wallet"}. Connect that wallet to edit its policy.`
                    : "Connect the wallet that owns this smart account (button at the top) to edit its policy."}
                </p>
              </section>
            )}
            <CallBuilder demo={demo} walletReady={walletOwns} data={signersData} busy={busy} version={signersVersion} contract={contract} functions={contractFunctions.functions} loading={contractFunctions.loading} nameOf={book.nameOf} onSend={(call, via) => void start({ action: "call", call, via })} />
          </div>
            </>
          )}

          {demo && (
            <>
          <section className="card">
            <div className="section-head">
              <h2>Demo steps</h2>
              <button className="ghost" disabled={busy} onClick={() => void start({ action: "steps", from: 1, to: 7 })}>
                Run steps 1–7 on this account
              </button>
            </div>
            <p className="muted small">
              "Run full demo" creates a fresh master account and smart account first (about a minute), then runs all
              seven steps. To reuse the current smart account (for example one you loaded), run the steps on it; step 2
              needs 9,500 XLM in the master, so return the funds first if the account still holds them. Per-step Run
              buttons also act on the current smart account.
            </p>
            <ol className="steps">
              {state.steps
                .filter((meta) => !meta.optional)
                .map((meta) => renderStep(meta))}
            </ol>
          </section>

          {state.steps.some((meta) => meta.optional) && (
            <section className="card">
              <div className="section-head">
                <h2>Expiry demo (optional)</h2>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    const optional = state.steps.filter((meta) => meta.optional).map((meta) => meta.n);
                    void start({ action: "steps", from: Math.min(...optional), to: Math.max(...optional) });
                  }}
                >
                  Run expiry demo
                </button>
              </div>
              <p className="muted small">
                Run after the main demo. The master shortens the delegate's expiry to about a minute; once the ledger
                passes it, the delegate's otherwise-allowed claim() is refused. Takes about a minute.
              </p>
              <ol className="steps">
                {state.steps
                  .filter((meta) => meta.optional)
                  .map((meta) => renderStep(meta))}
              </ol>
            </section>
          )}
            </>
          )}
          {state.pendingSignatures[0] && <SigningModal request={state.pendingSignatures[0]} signers={signers} onDone={() => void refresh()} />}
          {(demo || ready) && <CallHistory calls={state.calls} compact={!demo} />}

          {state.run.log.length > 0 &&
            (demo ? (
              <section className="card">
                <h2>Run log</h2>
                <pre className="log">{state.run.log.join("\n")}</pre>
              </section>
            ) : (
              <details className="card log-card">
                <summary>Run log ({state.run.log.length} lines)</summary>
                <pre className="log">{state.run.log.join("\n")}</pre>
              </details>
            ))}
          {toast && <Toast record={toast} onDismiss={dismissToast} />}
        </>
      )}
    </main>
  );
}
