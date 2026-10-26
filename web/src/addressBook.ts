import { useMemo, useSyncExternalStore } from "react";

// A shortlist of contracts for the policy editor and the call builder: a few built in (testnet), plus the
// ones the user saves, kept in this browser. A contract's functions are read from chain when it is picked, so
// an entry only needs a name and an id.

export interface BookEntry {
  id: string;
  label: string;
  /** What the contract is, shown under the picker. */
  note?: string;
  /** Built-in entries cannot be renamed or removed. */
  builtIn: boolean;
}

export interface SavedEntry {
  id: string;
  label: string;
}

/** The Blent fixed pool on testnet. */
export const BLENT_FIXED_POOL = "CCQBL3MLFNHXFMJ4YCRV7DEN4ST7UC7KV5PQ373LHJY6IL5V257V5UI4";
/** The Blent backstop on testnet. */
export const BLENT_BACKSTOP = "CBIQJM65BM3VFCV47IFH6K2XPCSZCXFBU5XNAUYPDALJJBJP24HC6HHS";

export const MAX_SAVED_ENTRIES = 50;
export const MAX_LABEL_LENGTH = 40;

const isContractId = (text: string) => /^C[A-Z2-7]{55}$/.test(text);

/** The simulator and native asset come from the server (so they match its `.env`); the Blent contracts are fixed. */
export function builtInEntries(known: { simulator?: string; nativeToken?: string } | null): BookEntry[] {
  const entries: BookEntry[] = [];
  if (known?.simulator) entries.push({ id: known.simulator, label: "Yield simulator", note: "Simulated yield-bearing protocol", builtIn: true });
  if (known?.nativeToken) entries.push({ id: known.nativeToken, label: "Native XLM (SAC)", note: "The native asset's contract: transfer, balance, approve…", builtIn: true });
  entries.push(
    { id: BLENT_FIXED_POOL, label: "Blent fixed pool (testnet)", note: "Blent lending pool", builtIn: true },
    { id: BLENT_BACKSTOP, label: "Blent backstop (testnet)", note: "Blent backstop for the pools", builtIn: true },
  );
  return entries;
}

/** Reads the saved list back, dropping anything malformed and any repeated id. */
export function parseSaved(text: string | null): SavedEntry[] {
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const saved: SavedEntry[] = [];
  for (const item of parsed as Partial<SavedEntry>[]) {
    const label = typeof item?.label === "string" ? item.label.trim() : "";
    if (typeof item?.id !== "string" || !isContractId(item.id) || label === "" || label.length > MAX_LABEL_LENGTH || seen.has(item.id)) continue;
    seen.add(item.id);
    saved.push({ id: item.id, label });
  }
  return saved.slice(0, MAX_SAVED_ENTRIES);
}

/** Adds an entry (newest last). `taken` holds ids already in the list, such as the built-in ones. */
export function addSaved(saved: readonly SavedEntry[], id: string, label: string, taken: ReadonlySet<string> = new Set()): SavedEntry[] {
  const cleanId = id.trim();
  const cleanLabel = label.trim();
  if (!isContractId(cleanId)) throw new Error("Enter a contract id (C…, 56 characters)");
  if (cleanLabel === "") throw new Error("Give it a name");
  if (cleanLabel.length > MAX_LABEL_LENGTH) throw new Error(`Keep the name to ${MAX_LABEL_LENGTH} characters`);
  if (taken.has(cleanId) || saved.some((s) => s.id === cleanId)) throw new Error("That contract is already in the list");
  if (saved.length >= MAX_SAVED_ENTRIES) throw new Error(`The list holds at most ${MAX_SAVED_ENTRIES} saved contracts`);
  return [...saved, { id: cleanId, label: cleanLabel }];
}

export const removeSaved = (saved: readonly SavedEntry[], id: string): SavedEntry[] => saved.filter((s) => s.id !== id);

/** Renames an entry; a blank or over-long name is ignored. */
export function renameSaved(saved: readonly SavedEntry[], id: string, label: string): SavedEntry[] {
  const clean = label.trim().slice(0, MAX_LABEL_LENGTH);
  return clean === "" ? [...saved] : saved.map((s) => (s.id === id ? { ...s, label: clean } : s));
}

// --- Browser store, shared by every component that uses the book and by other tabs ---

const STORAGE_KEY = "poc.addressBook.v1";
const listeners = new Set<() => void>();

function readStorage(): SavedEntry[] {
  try {
    return parseSaved(localStorage.getItem(STORAGE_KEY));
  } catch {
    return []; // no storage (private mode, or not a browser): the list just is not kept
  }
}

let current: SavedEntry[] = readStorage();

function update(next: SavedEntry[]): void {
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

export interface AddressBook {
  entries: BookEntry[];
  /** Adds a contract; throws a readable message when it cannot be added. */
  save: (id: string, label: string) => void;
  remove: (id: string) => void;
  rename: (id: string, label: string) => void;
  /** The entry's name, or the shortened id when it is not in the list. */
  nameOf: (id: string) => string;
}

export function useAddressBook(known: { simulator?: string; nativeToken?: string } | null): AddressBook {
  const saved = useSyncExternalStore(subscribe, () => current);
  const simulator = known?.simulator;
  const nativeToken = known?.nativeToken;
  return useMemo(() => {
    const builtIn = builtInEntries({ simulator, nativeToken });
    const taken = new Set(builtIn.map((entry) => entry.id));
    const entries = [...builtIn, ...saved.filter((s) => !taken.has(s.id)).map((s): BookEntry => ({ ...s, builtIn: false }))];
    return {
      entries,
      save: (id, label) => update(addSaved(current, id, label, taken)),
      remove: (id) => update(removeSaved(current, id)),
      rename: (id, label) => update(renameSaved(current, id, label)),
      nameOf: (id) => entries.find((entry) => entry.id === id)?.label ?? `${id.slice(0, 6)}…${id.slice(-6)}`,
    };
  }, [saved, simulator, nativeToken]);
}
