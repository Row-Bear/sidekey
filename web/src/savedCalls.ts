import { useMemo, useSyncExternalStore } from "react";
import type { CallRequest } from "@poc/core";

// Calls the user saves from the call builder to repeat in one click (such as claim()). They belong to one smart
// account and are kept in this browser only.

export const MAX_SAVED_CALLS = 6;
export const MAX_CALL_LABEL = 30;

export interface SavedCall {
  /** The smart account this call was saved for. */
  account: string;
  label: string;
  call: CallRequest;
}

const sameCall = (a: CallRequest, b: CallRequest) =>
  a.contract === b.contract && a.function === b.function && a.signer === b.signer && JSON.stringify(a.args) === JSON.stringify(b.args);

const isCallRequest = (c: unknown): c is CallRequest => {
  const call = c as Partial<CallRequest> | null;
  return (
    typeof call?.contract === "string" &&
    typeof call.function === "string" &&
    typeof call.signer === "string" &&
    Array.isArray(call.args) &&
    call.args.every((a) => typeof a === "string")
  );
};

/** Reads the stored list, dropping anything malformed and keeping at most MAX_SAVED_CALLS per account. */
export function parseSavedCalls(raw: string | null): SavedCall[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const saved: SavedCall[] = [];
  for (const item of parsed as Partial<SavedCall>[]) {
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    if (typeof item?.account !== "string" || label === "" || label.length > MAX_CALL_LABEL || !isCallRequest(item.call)) continue;
    const account = item.account;
    if (saved.filter((s) => s.account === account).length >= MAX_SAVED_CALLS) continue;
    saved.push({ account, label, call: { contract: item.call.contract, function: item.call.function, args: item.call.args, signer: item.call.signer } });
  }
  return saved;
}

/** Adds a call for an account (newest last); throws a readable message when it cannot be added. */
export function addSavedCall(saved: readonly SavedCall[], account: string, label: string, call: CallRequest): SavedCall[] {
  const clean = label.trim();
  if (clean === "") throw new Error("Give it a name");
  if (clean.length > MAX_CALL_LABEL) throw new Error(`Keep the name to ${MAX_CALL_LABEL} characters`);
  const mine = saved.filter((s) => s.account === account);
  if (mine.some((s) => sameCall(s.call, call))) throw new Error("This call is already saved");
  if (mine.length >= MAX_SAVED_CALLS) throw new Error(`You can save at most ${MAX_SAVED_CALLS} calls; remove one first`);
  return [...saved, { account, label: clean, call: { contract: call.contract, function: call.function, args: [...call.args], signer: call.signer } }];
}

export const removeSavedCall = (saved: readonly SavedCall[], account: string, index: number): SavedCall[] => {
  const mine = saved.filter((s) => s.account === account);
  const target = mine[index];
  return target ? saved.filter((s) => s !== target) : [...saved];
};

/** Renames the account's `index`-th call; a blank or over-long name is ignored. */
export function renameSavedCall(saved: readonly SavedCall[], account: string, index: number, label: string): SavedCall[] {
  const clean = label.trim();
  const target = saved.filter((s) => s.account === account)[index];
  if (!target || clean === "" || clean.length > MAX_CALL_LABEL) return [...saved];
  return saved.map((s) => (s === target ? { ...s, label: clean } : s));
}

/** A starting name: the function, plus the contract's name when it is not obvious. */
export const autoCallName = (fn: string, contractName: string): string => `${fn} · ${contractName}`.slice(0, MAX_CALL_LABEL);

// --- Browser store ---

const STORAGE_KEY = "poc.savedCalls.v1";
const listeners = new Set<() => void>();

function readStorage(): SavedCall[] {
  try {
    return parseSavedCalls(localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

let current: SavedCall[] = readStorage();

function update(next: SavedCall[]): void {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // keep the in-memory list for this session
  }
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    current = readStorage();
    listeners.forEach((listener) => listener());
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export interface SavedCalls {
  calls: SavedCall[];
  save: (label: string, call: CallRequest) => void;
  remove: (index: number) => void;
  rename: (index: number, label: string) => void;
}

/** The saved calls of one smart account. */
export function useSavedCalls(account: string): SavedCalls {
  const all = useSyncExternalStore(subscribe, () => current);
  return useMemo(
    () => ({
      calls: all.filter((s) => s.account === account),
      save: (label, call) => update(addSavedCall(current, account, label, call)),
      remove: (index) => update(removeSavedCall(current, account, index)),
      rename: (index, label) => update(renameSavedCall(current, account, index, label)),
    }),
    [all, account],
  );
}
