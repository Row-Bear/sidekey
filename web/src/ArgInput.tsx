import type { ArgInfo } from "@poc/core";

const PLACEHOLDER: Record<ArgInfo["kind"], string> = {
  address: "G… or C…",
  integer: "whole number",
  bool: "true or false",
  symbol: "name",
  string: "text",
  bytes: "hex bytes",
  json: "JSON",
};

/** One typed input for a contract argument. Address arguments get a "this account" shortcut. */
export function ArgInput({ arg, value, onChange, account, disabled }: {
  arg: ArgInfo;
  value: string;
  onChange: (value: string) => void;
  account: string;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {arg.name} <span className="muted">{arg.type}{arg.optional ? " (optional)" : ""}</span>
      </span>
      <span className="field-row">
        {arg.kind === "bool" ? (
          <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
            <option value="">choose…</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={arg.optional ? "empty = none" : PLACEHOLDER[arg.kind]}
            spellCheck={false}
            disabled={disabled}
          />
        )}
        {arg.kind === "address" && (
          <button type="button" className="ghost small-btn" onClick={() => onChange(account)} disabled={disabled}>
            this account
          </button>
        )}
      </span>
      {arg.kind === "integer" && arg.type.includes("128") && (
        <span className="muted hint">Whole number; XLM amounts are in stroops (1 XLM = 10,000,000).</span>
      )}
    </label>
  );
}
