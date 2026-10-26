// Where the static build keeps what the dev server keeps in files: the session (wallet, accounts, passkey) and
// the history of calls, both in this browser.
import { addCallRecord, type CallRecord, parseSession, serializeSession, type Session } from "../../../packages/core/src/browser.ts";

const SESSION_KEY = "sidekey.session";
const HISTORY_KEY = "sidekey.history";

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: the state lives for this page only
  }
};

let memorySession: Session | null = null;
export const loadSession = (): Session => memorySession ?? parseSession(read(SESSION_KEY));
export function saveSession(session: Session): void {
  memorySession = session;
  write(SESSION_KEY, serializeSession(session));
}

export function loadHistory(): CallRecord[] {
  try {
    const parsed = JSON.parse(read(HISTORY_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as CallRecord[]) : [];
  } catch {
    return [];
  }
}
export const saveRecord = (record: CallRecord): void => write(HISTORY_KEY, JSON.stringify(addCallRecord(loadHistory(), record)));
export const clearHistory = (): void => write(HISTORY_KEY, "[]");
