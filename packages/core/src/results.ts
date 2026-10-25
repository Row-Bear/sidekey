// Node-only: persists step results for the front end.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { StepResult } from "./scenario.js";

export type ResultsMap = Record<string, StepResult>;

export function loadResults(path: string | URL): ResultsMap {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ResultsMap) : {};
}

export function saveResult(path: string | URL, result: StepResult): void {
  const all = loadResults(path);
  all[String(result.step)] = result;
  writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
}

export function clearResults(path: string | URL): void {
  writeFileSync(path, "{}\n");
}
