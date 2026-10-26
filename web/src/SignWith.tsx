import type { SigningVia } from "./api-types";

/** Chooses where signatures come from: the demo's own keys, or the browser. */
export function SignWith({ value, onChange, disabled }: { value: SigningVia | "demo"; onChange: (v: SigningVia | "demo") => void; disabled?: boolean }) {
  return (
    <label className="sign-with">
      <span className="muted">Sign with</span>
      <select value={value} onChange={(e) => onChange(e.target.value as SigningVia | "demo")} disabled={disabled}>
        <option value="demo">Demo keys (server)</option>
        <option value="browser">My signature (wallet or pasted)</option>
      </select>
    </label>
  );
}
