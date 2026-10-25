import { useCallback, useEffect, useState } from "react";
import type { RuleView, StepResult } from "@poc/core";
import type { DemoState, StepMeta } from "./api-types";
import {
  accountUrl,
  describeRule,
  expiryText,
  fetchState,
  formatXlm,
  shortAddress,
  startRun,
  stepStatus,
  type StepStatus,
} from "./api";

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "Not run",
  running: "Running…",
  succeeded: "Succeeded",
  blocked: "Rejected by policy ✓",
  unexpected: "Unexpected result",
};

function AddressLink({ address, label }: { address: string; label?: string }) {
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

function RuleLine({ rule, simulator }: { rule: RuleView; simulator: string }) {
  const where = rule.contract === simulator ? "yield simulator" : shortAddress(rule.contract);
  return (
    <li>
      <code>{describeRule(rule)}</code> on {where}
    </li>
  );
}

function ExpiryLine({ validUntil, latest }: { validUntil: number | null; latest: number | null }) {
  if (validUntil === null) return <span className="tag">no expiry</span>;
  if (latest === null) return <span className="tag">expires at ledger {validUntil.toLocaleString("en-US")}</span>;
  if (latest > validUntil) return <span className="tag expired">expired at ledger {validUntil.toLocaleString("en-US")}</span>;
  return <span className="tag">{expiryText(validUntil, latest)}</span>;
}

function Policy({ state }: { state: DemoState }) {
  const policy = state.delegatePolicy;
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
              <span className="badge master">master</span> <AddressLink address={state.accounts.master} />
            </td>
            <td>Any call (default signer, never expires)</td>
          </tr>
          <tr>
            <td>
              <span className="badge delegate">delegate</span> <AddressLink address={state.accounts.delegate} />
            </td>
            <td>
              {policy === null ? (
                <span className="muted">Not registered yet (step 1 sets the policy)</span>
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
                          simulator={state.accounts.simulator}
                        />
                      ))}
                    </ul>
                  )}
                </>
              )}
              <span className="muted small">Everything else, including withdraw(), is refused.</span>
            </td>
          </tr>
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

export default function App() {
  const [state, setState] = useState<DemoState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await fetchState());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const busy = state?.run.busy ?? false;
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), busy ? 2000 : 6000);
    return () => clearInterval(timer);
  }, [refresh, busy]);

  const start = async (request: Parameters<typeof startRun>[0]) => {
    try {
      await startRun(request);
      await refresh();
    } catch (err) {
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

  return (
    <main>
      <header>
        <div>
          <h1>Stellar Smart Account PoC</h1>
          <p className="muted">
            A Soroban smart account with a default G-address signer and a policy that lets a delegate call only
            specific functions on specific contracts. Stellar testnet.
          </p>
        </div>
        <div className="controls">
          <button disabled={busy} onClick={() => void start({ action: "full" })}>
            {busy ? "Running…" : "Run full demo"}
          </button>
          <button className="ghost" disabled={busy} onClick={() => void start({ action: "fresh" })}>
            New account only
          </button>
        </div>
      </header>

      {error && <p className="error banner">{error}</p>}
      {!state ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {state.run.label && <p className="banner running">{state.run.label}</p>}
          {state.run.lastError && <p className="error banner">{state.run.lastError}</p>}
          <div className="grid">
            <Accounts state={state} />
            <Balances state={state} />
            <Policy state={state} />
          </div>

          <section className="card">
            <h2>Demo steps</h2>
            <p className="muted small">
              "Run full demo" creates a fresh master account and smart account first (about a minute), then runs all
              seven steps. Per-step Run buttons act on the current smart account.
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

          {state.run.log.length > 0 && (
            <section className="card">
              <h2>Run log</h2>
              <pre className="log">{state.run.log.join("\n")}</pre>
            </section>
          )}
        </>
      )}
    </main>
  );
}
