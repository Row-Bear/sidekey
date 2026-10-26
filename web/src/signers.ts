import type { SignerView } from "@poc/core";

export type SignerStatus =
  | { kind: "master" }
  | { kind: "unregistered" }
  | { kind: "no-expiry" }
  | { kind: "active"; validUntil: number }
  | { kind: "expired"; validUntil: number };

/** Where a signer stands: the master never expires, an unregistered one has no policy, a registered one may have run out. */
export function signerStatus(signer: SignerView, latestLedger: number): SignerStatus {
  if (signer.label === "master") return { kind: "master" };
  if (!signer.registered || !signer.policy) return { kind: "unregistered" };
  const validUntil = signer.policy.validUntilLedger;
  if (validUntil === null) return { kind: "no-expiry" };
  return latestLedger > validUntil ? { kind: "expired", validUntil } : { kind: "active", validUntil };
}

const RANK: Record<SignerStatus["kind"], number> = { master: 0, active: 1, "no-expiry": 1, unregistered: 2, expired: 3 };

/**
 * The signers other than the master, most relevant first: the account's own delegate (the passkey), then other working
 * signers, then ones not registered yet, then expired ones. Order among equals is kept.
 */
export function delegatesFirst(signers: readonly SignerView[], latestLedger: number): SignerView[] {
  const key = (s: SignerView) => (s.label === "delegate" ? -1 : RANK[signerStatus(s, latestLedger).kind]);
  return signers
    .filter((s) => s.label !== "master")
    .map((signer, index) => ({ signer, index }))
    .sort((a, b) => key(a.signer) - key(b.signer) || a.index - b.index)
    .map(({ signer }) => signer);
}

/** What running a rule as its signer would call: complete when every argument is fixed by the rule. */
export interface RuleCall {
  function: string;
  args: string[];
  /** False when some argument is left open ("any" or a limit), so the user has to supply it first. */
  complete: boolean;
}

const looksStructured = (display: string) => /^[[{]/.test(display) || display.startsWith("0x");

export function callFromRule(rule: { function: string; args: { kind: string; display?: string }[] }, account: string): RuleCall {
  let complete = true;
  const args = rule.args.map((a) => {
    if (a.kind === "self") return account;
    // Structured values may not read back through the form's input format, so the builder is asked to confirm them.
    if (a.kind === "exact" && a.display !== undefined && !looksStructured(a.display)) return a.display;
    complete = false;
    return a.kind === "exact" && a.display !== undefined ? a.display : "";
  });
  return { function: rule.function, args, complete };
}
