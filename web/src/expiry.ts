import type { ExpiryInput } from "@poc/core";

export const LEDGERS_PER_MINUTE = 12;
/** The account's stored policy lives about this long after the last policy change (see the contract's TTL). */
export const STORAGE_LIFETIME_MINUTES = 30 * 1440;

export type ExpiryKind = "none" | "minutes" | "hours" | "days" | "ledger";

const MINUTES_PER: Record<"minutes" | "hours" | "days", number> = { minutes: 1, hours: 60, days: 1440 };

/** The edit's expiry from what was typed, or null when the number is missing or not above zero. */
export function toExpiry(kind: ExpiryKind, value: string): ExpiryInput | null {
  if (kind === "none") return { kind: "none" };
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return kind === "ledger" ? { kind: "ledger", ledger: Math.floor(n) } : { kind: "minutes", minutes: n * MINUTES_PER[kind] };
}
