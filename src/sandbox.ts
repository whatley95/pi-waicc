import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * An OS sandbox around a check: it may write only to its working folder, the temp folder and
 * any folders you allow, and reaches no network unless you allow it. macOS uses sandbox-exec,
 * Linux bubblewrap (bwrap). Windows has no sandbox WAICC can use without native code.
 */
export type SandboxMode = "off" | "auto" | "required";
export type SandboxBackend = "sandbox-exec" | "bwrap";
export interface SandboxSettings { mode: SandboxMode; network: boolean; allowWrite: string[] }
export interface SandboxPlan {
  program: string; args: string[];
  /** What ran the check, or null when it ran with your full permissions. */
  sandbox: { backend: SandboxBackend; network: boolean; writable: string[] } | null;
  note: string | null;
}

const macSandbox = "/usr/bin/sandbox-exec";
let bwrapWorks: boolean | undefined;
/** Whether this system's sandbox exists and works here; bwrap is tried once, as some systems forbid it. */
export function sandboxAvailable(platform = process.platform): SandboxBackend | null {
  if (platform === "darwin") return existsSync(macSandbox) ? "sandbox-exec" : null;
  if (platform !== "linux") return null;
  bwrapWorks ??= (() => {
    try {
      return spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "--", "true"], { stdio: "ignore", timeout: 5000 }).status === 0;
    } catch {
      return false;
    }
  })();
  return bwrapWorks ? "bwrap" : null;
}

/** "~/x" is your home folder; anything else must already be absolute. */
export const expandHome = (path: string): string => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
/** Each folder as given and as the system resolves it, so /tmp and /private/tmp both count. */
function writableFolders(folders: string[]): string[] {
  const all = new Set<string>();
  for (const folder of folders) {
    if (!isAbsolute(folder)) continue;
    all.add(folder);
    try {
      all.add(realpathSync.native(folder));
    } catch { /* not there yet: its own spelling only */ }
  }
  return [...all].sort();
}
const sbplString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** Everything may be read; writes only below the given folders and to standard devices; no IP traffic unless allowed. */
export function macProfile(writable: string[], network: boolean): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((path) => `(subpath ${sbplString(path)})`).join(" ")} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
    ...(network ? [] : ["(deny network-outbound (remote ip))", "(deny network-inbound (local ip))"]),
  ].join("\n");
}

export function sandboxPlan(program: string, args: string[], cwd: string, settings: SandboxSettings,
  platform = process.platform, available: (platform: NodeJS.Platform) => SandboxBackend | null = sandboxAvailable): SandboxPlan {
  if (settings.mode === "off") return { program, args, sandbox: null, note: null };
  const backend = available(platform);
  if (!backend) {
    const why = platform === "win32" ? "Windows has no sandbox WAICC can use yet"
      : platform === "linux" ? "bubblewrap (bwrap) is not installed or not permitted here" : `${platform} has no supported sandbox`;
    if (settings.mode === "required")
      throw new Error(`Your settings require a sandbox for checks ("sandbox.checks": "required"), but ${why}. The check was not run; report it not_run with that limit.`);
    return { program, args, sandbox: null, note: `No sandbox: ${why}, so the check ran with your own permissions.` };
  }
  const writable = writableFolders([cwd, tmpdir(), ...settings.allowWrite.map(expandHome)]);
  const sandbox = { backend, network: settings.network, writable };
  if (backend === "sandbox-exec")
    return { program: macSandbox, args: ["-p", macProfile(writable, settings.network), program, ...args], sandbox, note: null };
  return {
    program: "bwrap",
    args: [
      "--die-with-parent", "--new-session", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
      ...writable.filter((path) => existsSync(path)).flatMap((path) => ["--bind", path, path]),
      ...(settings.network ? [] : ["--unshare-net"]),
      "--chdir", cwd, "--", program, ...args,
    ],
    sandbox, note: null,
  };
}
