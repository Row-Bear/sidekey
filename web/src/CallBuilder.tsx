import { useEffect, useRef, useState } from "react";
import type { CallRequest, FunctionInfo, PreviewResult, SignerView } from "@poc/core";
import { expiryText, friendlyError, requestPreview, shortAddress, type SignersResponse } from "./api";
import { ArgInput } from "./ArgInput";
import type { SigningVia } from "./api-types";
import { useDebounced } from "./hooks";
import { SignWith } from "./SignWith";
import { delegatesFirst } from "./signers";
import { examplesFor } from "./examples";

function signerOptionLabel(signer: SignerView, latestLedger: number, demo: boolean): string {
  if (signer.label === "master") return `master ${shortAddress(signer.address)}: may authorize anything`;
  const policy = signer.policy;
  const state = !signer.registered
    ? "not registered"
    : policy?.validUntilLedger == null
      ? "no expiry"
      : latestLedger > policy.validUntilLedger
        ? "expired"
        : expiryText(policy.validUntilLedger, latestLedger);
  return `${signer.label} ${shortAddress(signer.address)}: ${state}${signer.hasKey || !demo ? "" : " (no key in demo mode)"}`;
}

function PreviewBox({ preview }: { preview: PreviewResult | "loading" | null }) {
  if (preview === null) return <div className="verdict muted">Choose a function to preview the policy check.</div>;
  if (preview === "loading") return <div className="verdict muted">Checking the policy…</div>;
  const tree = preview.status === "allowed" || preview.status === "rejected" ? preview.tree : [];
  const heading = {
    allowed: "✓ Allowed by the signer's policy",
    rejected: "✗ Would be rejected by the policy",
    "simulation-failed": "The call itself would fail",
    invalid: "Fill in the call",
  }[preview.status];
  // Incomplete inputs are not an error yet, so they get the quiet style; raw host errors are kept under Details.
  const friendly = preview.status === "simulation-failed" ? friendlyError(preview.message) : { summary: preview.message };
  return (
    <div className={`verdict ${preview.status === "invalid" ? "muted" : preview.status}`}>
      <strong>{heading}</strong>
      <div>{friendly.summary}</div>
      {friendly.detail && (
        <details>
          <summary>Details</summary>
          <code className="raw-error">{friendly.detail}</code>
        </details>
      )}
      {tree.length > 0 && (
        <details>
          <summary>Calls the account must authorize ({tree.length})</summary>
          <ul>{tree.map((line) => <li key={line}><code>{line}</code></li>)}</ul>
        </details>
      )}
    </div>
  );
}

export function CallBuilder({ demo = true, walletReady = true, data, busy, version, contract, functions, loading, nameOf, onSend }: {
  /** The guided demo can sign with the keys it holds; the plain page always signs in the browser (wallet, passkey or pasted). */
  demo?: boolean;
  /** Whether the master can sign now (the wallet that owns the account is connected). The delegate's passkey needs no wallet. */
  walletReady?: boolean;
  data: SignersResponse | null;
  busy: boolean;
  /** Bumps when on-chain state may have changed, so the preview refreshes. */
  version: number;
  /** The contract chosen in the shared picker, and its functions. */
  contract: string;
  functions: FunctionInfo[];
  loading: boolean;
  nameOf: (id: string) => string;
  onSend: (call: CallRequest, via?: SigningVia) => void;
}) {
  const simulator = data?.simulator ?? "";
  const account = data?.smartAccount ?? "";
  const [fnName, setFnName] = useState("");
  const [args, setArgs] = useState<string[]>([]);
  const [signerId, setSignerId] = useState("");
  const [preview, setPreview] = useState<PreviewResult | "loading" | null>(null);
  const [via, setVia] = useState<SigningVia | "demo">(demo ? "demo" : "browser");
  const presetArgs = useRef<string[] | null>(null);

  useEffect(() => {
    if (data && signerId === "") setSignerId(data.signers.find((s) => s.label === "delegate")?.id ?? "master");
  }, [data, signerId]);

  useEffect(() => {
    if (!functions.some((f) => f.name === fnName)) setFnName(functions[0]?.name ?? "");
  }, [functions, fnName]);

  const fn = functions.find((f) => f.name === fnName) ?? null;
  useEffect(() => {
    setArgs(presetArgs.current ?? (fn?.args ?? []).map(() => ""));
    presetArgs.current = null;
  }, [fn?.name, contract]);

  const signer = data?.signers.find((s) => s.id === signerId) ?? null;
  // The master, then the delegate and the other signers, most relevant first.
  const orderedSigners = data ? [...data.signers.filter((s) => s.label === "master"), ...delegatesFirst(data.signers, data.latestLedger)] : [];
  const request: CallRequest | null = fn && signerId ? { contract: contract.trim(), function: fn.name, args, signer: signerId } : null;
  const requestKey = useDebounced(JSON.stringify(request), 700);

  useEffect(() => {
    if (requestKey === "null") return setPreview(null);
    let cancelled = false;
    setPreview("loading");
    requestPreview(JSON.parse(requestKey) as CallRequest)
      .then((result) => !cancelled && setPreview(result))
      .catch((err) => !cancelled && setPreview({ status: "invalid", message: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [requestKey, version]);

  // Examples belong to the selected contract, so choosing one only fills in the function and its arguments.
  const examples = examplesFor(contract, { simulator, nativeToken: data?.nativeToken ?? "", account, master: data?.master ?? "" });
  const applyExample = (e: { fn: string; args: string[] }) => {
    presetArgs.current = e.args;
    setFnName(e.fn);
    setArgs(e.args);
  };

  const rejected = preview !== null && preview !== "loading" && preview.status === "rejected";
  // With demo keys only signers the demo holds a key for can send; in the browser anyone can be asked.
  const masterBlocked = !demo && !walletReady && signerId === "master";
  const canSend = !busy && request !== null && !masterBlocked && (via === "browser" || signer?.hasKey === true || signer?.viaBrowser === true);

  return (
    <section className="card">
      <h2>Call builder</h2>
      <p className="muted small">
        Pick a signer and a call. The policy check below runs the real simulation and tests every call the account
        would have to authorize, without sending anything.
      </p>
      {examples.length > 0 && (
        <div className="chips">
          <span className="muted small">Examples:</span>
          {examples.map((e) => (
            <button key={e.label} type="button" className="chip" onClick={() => applyExample(e)}>
              {e.label}
            </button>
          ))}
        </div>
      )}

      <label className="field">
        <span className="field-label">Call as</span>
        <select value={signerId} onChange={(e) => setSignerId(e.target.value)} disabled={!data}>
          {orderedSigners.map((s) => (
            <option
              key={s.id}
              value={s.id}
              disabled={(!s.hasKey && !s.viaBrowser && via !== "browser") || (!demo && !walletReady && s.id === "master")}
            >
              {signerOptionLabel(s, data?.latestLedger ?? 0, demo)}
              {!demo && !walletReady && s.id === "master" ? " (connect your wallet)" : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="muted small contract-line">Contract: <strong>{nameOf(contract.trim())}</strong> (chosen above)</div>

      <label className="field">
        <span className="field-label">Function {loading && <span className="muted">(loading…)</span>}</span>
        <select value={fnName} onChange={(e) => setFnName(e.target.value)} disabled={functions.length === 0}>
          {functions.map((f) => <option key={f.name} value={f.name}>{f.name}({f.args.map((a) => a.name).join(", ")})</option>)}
        </select>
      </label>

      {fn?.args.map((arg, i) => (
        <ArgInput
          key={`${contract}.${fn.name}.${arg.name}`}
          arg={arg}
          value={args[i] ?? ""}
          onChange={(value) => setArgs((current) => current.map((v, j) => (j === i ? value : v)))}
          account={account}
        />
      ))}

      {demo && <SignWith value={via} onChange={setVia} disabled={busy} />}

      <PreviewBox preview={preview} />

      <div className="actions">
        <button disabled={!canSend} onClick={() => request && onSend(request, via === "browser" ? "browser" : undefined)}>
          {busy ? "Working…" : rejected ? "Send anyway (expect a rejection)" : "Send"}
        </button>
        {demo && signer && !signer.hasKey && !signer.viaBrowser && via !== "browser" && <span className="muted small">This demo holds no key for that signer.</span>}
        {signer?.viaBrowser && <span className="muted small">{signer.kind === "passkey" ? "Signed with your passkey." : "Signed in your wallet."}</span>}
      </div>
    </section>
  );
}
