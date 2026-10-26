import type { FunctionInfo } from "@poc/core";

// Helpers for choosing a contract function. A contract's interface does not say which functions only read, so this
// goes by the usual naming (`get_*`, `balance`, `*_balance`...). It is a hint for ordering and hiding, not a rule:
// the call builder's preview is what says whether a call needs the account's authorization.

const READ_PREFIXES = ["get_", "is_", "has_", "list_", "total_", "check_", "query_", "view_", "preview_", "calc_", "calculate_", "estimate_", "accrued_"];
const READ_SUFFIXES = ["_balance", "_price", "_list"];
const READ_NAMES = new Set([
  "balance", "allowance", "decimals", "name", "symbol", "authorized", "admin", "version", "master", "owner",
  "supply", "reward_zone", "pool_data", "backstop_token", "bad_debt",
]);

/** Whether the name looks like a function that only reads. */
export function looksReadOnly(name: string): boolean {
  return READ_NAMES.has(name) || READ_PREFIXES.some((p) => name.startsWith(p)) || READ_SUFFIXES.some((s) => name.endsWith(s));
}

const ADMIN_PREFIXES = ["set_", "update_", "propose_", "accept_", "force_", "queue_set_", "cancel_set_"];
const ADMIN_NAMES = new Set(["clawback", "mint", "upgrade"]);

/** Whether the name looks like an administrative function (settings, ownership, minting): never a good place to start. */
export const looksAdministrative = (name: string): boolean => ADMIN_NAMES.has(name) || ADMIN_PREFIXES.some((p) => name.startsWith(p));

export interface FunctionGroups {
  /** Functions that look like they change something, the ones that matter for permissions. */
  actions: FunctionInfo[];
  /** Functions that look read-only. */
  reads: FunctionInfo[];
}

/** Splits the list into actions and reads, each in its original order but with `allowed` functions first. */
export function groupFunctions(functions: readonly FunctionInfo[], allowed: ReadonlySet<string> = new Set()): FunctionGroups {
  const firstAllowed = (list: FunctionInfo[]) => [...list.filter((f) => allowed.has(f.name)), ...list.filter((f) => !allowed.has(f.name))];
  return {
    actions: firstAllowed(functions.filter((f) => !looksReadOnly(f.name))),
    reads: firstAllowed(functions.filter((f) => looksReadOnly(f.name))),
  };
}

/**
 * The function to start on: the first action that is not administrative, so a form opens neither on a read-only function
 * nor on something like `accept_admin`. Falls back to any action, then to the first function.
 */
export function defaultFunction(functions: readonly FunctionInfo[]): string {
  const actions = functions.filter((f) => !looksReadOnly(f.name));
  return (actions.find((f) => !looksAdministrative(f.name)) ?? actions[0] ?? functions[0])?.name ?? "";
}

/** `deposit(user: Address, amount: i128)`: the name with its argument names and types. */
export const describeSignature = (fn: FunctionInfo): string =>
  `${fn.name}(${fn.args.map((a) => `${a.name}: ${a.type}${a.optional ? "?" : ""}`).join(", ")})`;

/** Whether a typed search matches a function's name, arguments or description (case does not matter). */
export function matchesQuery(fn: FunctionInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [fn.name, fn.doc, ...fn.args.flatMap((a) => [a.name, a.type])].some((text) => text.toLowerCase().includes(q));
}
