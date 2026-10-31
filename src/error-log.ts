import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runtimePath } from "./files.ts";

/**
 * Errors WAICC showed the human, kept in the project's own WAICC folder (ignored by Git), so a
 * later look at what went wrong does not depend on someone remembering the message. Notices
 * shown in Pi are not part of the saved chat.
 */
export const errorLogName = "errors.jsonl";
/** Past this size the oldest half is dropped, so the file stays small. */
export const errorLogLimit = 256 * 1024;

export interface ErrorEntry {
  at: string;
  /** Where it came from: a command name, "picker", "dispatch", "continue", ... */
  source: string;
  message: string;
}

/** Only in a project that already has its WAICC folder: a failed command elsewhere creates nothing. */
export function recordError(root: string, source: string, message: string): void {
  const folder = join(root, runtimePath);
  if (!existsSync(folder)) return;
  const path = join(folder, errorLogName);
  try {
    const entry: ErrorEntry = { at: new Date().toISOString(), source: source.slice(0, 80), message: message.slice(0, 2_000) };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    if (statSync(path).size > errorLogLimit) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      writeFileSync(path, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`);
    }
  } catch { /* the log only helps later; it must never turn into an error of its own */ }
}

export function readErrors(root: string): ErrorEntry[] {
  const path = join(root, runtimePath, errorLogName);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as ErrorEntry] : [];
    } catch {
      return [];
    }
  });
}
