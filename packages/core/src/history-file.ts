// Node-only: keeps the call history in a file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { addCallRecord, type CallRecord } from "./history.js";

export function loadCallHistory(path: string | URL): CallRecord[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as CallRecord[]) : [];
}

export function saveCallRecord(path: string | URL, record: CallRecord): void {
  writeFileSync(path, JSON.stringify(addCallRecord(loadCallHistory(path), record), null, 2) + "\n");
}

export function clearCallHistory(path: string | URL): void {
  writeFileSync(path, "[]\n");
}
