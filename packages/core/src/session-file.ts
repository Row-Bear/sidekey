// Node-only: keeps the session in a file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseSession, serializeSession, type Session } from "./session.js";

export const loadSession = (path: string | URL): Session => parseSession(existsSync(path) ? readFileSync(path, "utf8") : null);

export function saveSession(path: string | URL, session: Session): void {
  writeFileSync(path, serializeSession(session));
}
