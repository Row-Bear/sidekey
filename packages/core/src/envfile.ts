// Node-only helpers (filesystem and Stellar CLI). The browser app imports types from this
// package only, so none of this is bundled into the front end.
import { readFileSync, writeFileSync } from "node:fs";

export function setEnvValues(path: string | URL, values: Record<string, string>): void {
  let text = readFileSync(path, "utf8");
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
  }
  writeFileSync(path, text);
}
