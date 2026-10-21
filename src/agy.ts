import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensure } from "./validation.ts";

/**
 * Antigravity (agy) has no per-run MCP option: it reads MCP servers from its own config, and in
 * headless mode it denies any MCP call that its settings do not allow. So each run registers its
 * own server, pinned to the one request like the other agents', and allows exactly WAICC's
 * recipient tools on it; both are removed when the run ends. Nothing else in agy's settings is
 * touched. Entries a crashed run left behind are removed after three hours.
 */
export interface AgyServer { name: string; command: string; args: string[] }
export type AgyRunner = (args: string[]) => string;

const runAgy: AgyRunner = (args) => execFileSync("agy", args, { encoding: "utf8", windowsHide: true, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
export const agySettingsPath = (): string => join(homedir(), ".gemini", "antigravity-cli", "settings.json");
const prefix = "waicc-run-";
const staleMs = 3 * 3_600_000;

/** "waicc-run-202610211930-670a33b8": the UTC minute it started, so leftovers can be told apart. */
export function agyServerName(dispatchId: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 12);
  return `${prefix}${stamp}-${dispatchId.replace(/[^a-f0-9]/gi, "").slice(0, 8)}`;
}
const startedAt = (name: string): number | null => {
  const m = new RegExp(`^${prefix}(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})-`).exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
};

function readSettings(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    ensure(value && typeof value === "object" && !Array.isArray(value), "not an object");
    return value;
  } catch (error) {
    throw new Error(`Antigravity's settings (${path}) are not valid JSON, so WAICC left them alone and did not dispatch: ${error instanceof Error ? error.message : String(error)}`);
  }
}
/** Changes only permissions.allow, keeping every other setting and rule. */
function editAllow(path: string, change: (allow: string[]) => string[]): void {
  const settings = readSettings(path);
  const permissions = settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {};
  const allow: string[] = Array.isArray(permissions.allow) ? permissions.allow.filter((r: unknown) => typeof r === "string") : [];
  const next = change(allow);
  if (JSON.stringify(next) === JSON.stringify(allow)) return;
  settings.permissions = { ...permissions, allow: next };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Removes WAICC run servers and their rules older than three hours: what a crashed run left. */
export function removeStaleAgyServers(run: AgyRunner = runAgy, settings = agySettingsPath(), now = Date.now()): string[] {
  const old = (name: string) => {
    const at = startedAt(name);
    return at !== null && now - at > staleMs;
  };
  let listed = "";
  try {
    listed = run(["mcp", "list"]);
  } catch { /* nothing to clean if agy cannot list */ }
  const names = [...listed.matchAll(new RegExp(`(?:^|\\s)(${prefix}\\d{12}-[a-f0-9]{1,8})(?=\\s)`, "gim"))].map((m) => m[1]).filter(old);
  for (const name of names)
    try {
      run(["mcp", "remove", name]);
    } catch { /* gone already */ }
  editAllow(settings, (allow) => allow.filter((rule) => {
    const name = new RegExp(`^mcp\\((${prefix}[^/)]+)/`).exec(rule)?.[1];
    return !name || !old(name);
  }));
  return names;
}

/** Registers the run's pinned server and allows exactly these tools on it. */
export function registerAgyServer(server: AgyServer, tools: readonly string[], run: AgyRunner = runAgy, settings = agySettingsPath()): void {
  removeStaleAgyServers(run, settings);
  // Flags go before the name; "--" lets the command and its arguments start with anything.
  try {
    run(["mcp", "add", server.name, "--", server.command, ...server.args]);
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    throw new Error(`Could not register WAICC's server with Antigravity (agy mcp add): ${(e.stderr || e.message || String(error)).trim().split("\n")[0]}`);
  }
  try {
    editAllow(settings, (allow) => [...allow.filter((r) => !r.startsWith(`mcp(${server.name}/`)), ...tools.map((tool) => `mcp(${server.name}/${tool})`)]);
  } catch (error) {
    unregisterAgyServer(server.name, run, settings);
    throw error;
  }
}

/** Removes the run's server and its rules; never fails the run. */
export function unregisterAgyServer(name: string, run: AgyRunner = runAgy, settings = agySettingsPath()): void {
  try {
    run(["mcp", "remove", name]);
  } catch { /* already gone */ }
  try {
    editAllow(settings, (allow) => allow.filter((rule) => !rule.startsWith(`mcp(${name}/`)));
  } catch { /* the settings became unreadable: nothing of WAICC's can be removed from them */ }
}
