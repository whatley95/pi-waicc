import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  /** A warning, or (the default) an error. */
  level?: "error" | "warning";
  /** The WAICC that raised it: package version, and its commit when it runs from a Git checkout. */
  version?: string;
  /** Pi's chat, and the WAICC session it had selected. */
  chat?: string;
  sessionId?: string;
  /** A tool's arguments as names and types only (see argumentShape): never their text. */
  args?: unknown;
  /** The command or run it happened in: its steps are in the activity log under the same flow. */
  flow?: string;
}
export type ErrorContext = Pick<ErrorEntry, "level" | "chat" | "sessionId" | "args" | "flow">;

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
let running: string | undefined;
/** Told apart from the current code, an error from a Pi that still runs an older WAICC is no new bug. */
export function waiccVersion(): string {
  if (running !== undefined) return running;
  running = "unknown";
  try {
    running = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;
    // Only its own checkout: installed inside another repository, that one's commit would be named.
    if (existsSync(join(packageRoot, ".git")))
      running += ` ${execFileSync("git", ["-C", packageRoot, "rev-parse", "--short=10", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, windowsHide: true }).trim()}`;
  } catch { /* the version helps; it never stands in the way */ }
  return running;
}

/**
 * What an agent sent, without what it said: field names and value types, arrays as their length
 * and their entries' fields (a field only some entries have says in how many). Text that looks
 * like JSON is marked, since a nested JSON string is a common mistake.
 */
export function argumentShape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (typeof value === "string") return /^\s*[{[]/.test(value) ? "string (JSON text)" : "string";
  if (typeof value !== "object") return typeof value;
  if (depth >= 5) return Array.isArray(value) ? `array (${value.length})` : "object";
  if (Array.isArray(value)) {
    if (!value.length || !value.every((item) => item && typeof item === "object" && !Array.isArray(item)))
      return value.length ? [`${value.length}×`, argumentShape(value[0], depth + 1)] : [];
    const items = value as Record<string, unknown>[];
    const fields = [...new Set(items.flatMap((item) => Object.keys(item)))].slice(0, 40);
    return [`${items.length}×`, Object.fromEntries(fields.map((field) => {
      const having = items.filter((item) => field in item);
      return [`${field.slice(0, 60)}${having.length < items.length ? ` (in ${having.length} of ${items.length})` : ""}`, argumentShape(having[0][field], depth + 2)];
    }))];
  }
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([field, inner]) => [field.slice(0, 60), argumentShape(inner, depth + 1)]));
}

/** Only in a project that already has its WAICC folder: a failed command elsewhere creates nothing. */
export function recordError(root: string, source: string, message: string, context: ErrorContext = {}): void {
  const folder = join(root, runtimePath);
  if (!existsSync(folder)) return;
  const path = join(folder, errorLogName);
  try {
    const args = context.args === undefined ? undefined : JSON.stringify(context.args).length <= 4_000 ? context.args : "(too large to keep)";
    const entry: ErrorEntry = {
      at: new Date().toISOString(), source: source.slice(0, 80), message: message.slice(0, 2_000),
      level: context.level ?? "error", version: waiccVersion(),
      ...(context.chat ? { chat: context.chat.slice(0, 80) } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId.slice(0, 80) } : {}),
      ...(args === undefined ? {} : { args }),
      ...(context.flow ? { flow: context.flow.slice(0, 40) } : {}),
    };
    appendCapped(path, JSON.stringify(entry), errorLogLimit);
  } catch { /* the log only helps later; it must never turn into an error of its own */ }
}

/** Adds a line; past the limit the oldest half of the file is dropped. */
export function appendCapped(path: string, line: string, limit: number): void {
  appendFileSync(path, `${line}\n`);
  if (statSync(path).size > limit) {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    writeFileSync(path, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`);
  }
}

/** A time to read errors from: an ISO time, or how long ago (30m, 6h, 2d). */
export function sinceTime(value: string, now = Date.now()): string {
  const ago = /^(\d+)([mhd])$/.exec(value.trim());
  const at = ago ? now - Number(ago[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2] as "m" | "h" | "d"] : Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`Not a time: ${JSON.stringify(value)}. Use an ISO time such as 2026-11-03T08:00Z, or how long ago: 30m, 6h, 2d`);
  return new Date(at).toISOString();
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
