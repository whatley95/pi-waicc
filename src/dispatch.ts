import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifact, json, loadSession, now, safePath, sessionRelative, withLock } from "./files.ts";
import { commitWithCheckpoint as commit } from "./checkpoint.ts";
import { roundDirectory } from "./render.ts";
import { projectRoot, snapshot } from "./source.ts";
import { ensure } from "./validation.ts";
import type { Mode } from "./types.ts";

export const agents = ["claude", "codex", "pi", "agy"] as const;
export type Agent = (typeof agents)[number];
/** Roles whose recipient never needs to edit source; implementation stays a manual Pi handoff. */
const dispatchModes: Mode[] = ["planning", "review", "advisor"];

export interface DispatchOptions {
  via: Agent;
  model?: string;
  timeoutMinutes?: number;
  /** Explicit opt-in for an implementation handoff; Pi only. */
  implement?: boolean;
}
export interface AgentResult {
  stdout: string; stderr: string; code: number; killed: boolean;
}
export type AgentRunner = (program: string, args: string[], options: {
  cwd: string; timeout: number; signal?: AbortSignal; env?: Record<string, string>;
}) => Promise<AgentResult>;
/** Set by dispatch only: the Pi extension pins this request read-only at startup. */
export const dispatchPinVariable = "WAICC_DISPATCH_PIN";

export function dispatchOptions(input: string): DispatchOptions {
  const words = input.split(/\s+/).filter(Boolean);
  const options: Partial<DispatchOptions> = {};
  for (let i = 0; i < words.length; i += 2) {
    const [flag, value] = [words[i], words[i + 1]];
    if (flag === "--implement") {
      options.implement = true;
      i -= 1; // A switch takes no value.
      continue;
    }
    ensure(value !== undefined, `${flag} requires a value`);
    if (flag === "--via") {
      ensure((agents as readonly string[]).includes(value), `--via must be one of ${agents.join(", ")}`);
      options.via = value as Agent;
    } else if (flag === "--model" || flag === "-m") {
      ensure(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(value), "Invalid model name");
      options.model = value;
    } else if (flag === "--timeout") {
      const minutes = Number(value);
      ensure(Number.isInteger(minutes) && minutes >= 1 && minutes <= 120, "--timeout must be 1–120 minutes");
      options.timeoutMinutes = minutes;
    } else ensure(false, `Unknown dispatch option ${flag}`);
  }
  ensure(options.via, `Usage: --via ${agents.join("|")} [--model <model>] [--timeout <minutes>] [--implement]`);
  return options as DispatchOptions;
}

const here = fileURLToPath(import.meta.url);
/** Same build as this module, except installed TypeScript: Node cannot strip types under node_modules. */
function waiccCli(): string {
  const compiled = join(dirname(dirname(here)), "dist", "cli.js");
  return extname(here) === ".ts" && /[\\/]node_modules[\\/]/.test(here) && existsSync(compiled)
    ? compiled
    : join(dirname(here), `cli${extname(here)}`);
}
const extensionEntry = (): string => join(dirname(here), `index${extname(here)}`);
const recipientTools = ["waicc_receive", "waicc_assignment", "waicc_validate_reply", "waicc_submit_reply"];

export interface DispatchPlan {
  dispatchId: string;
  root: string;
  sessionId: string;
  requestId: string;
  mode: Mode;
  via: Agent;
  model: string | null;
  timeoutMs: number;
  program: string;
  args: string[];
  env: Record<string, string>;
  prompt: string;
  replyPath: string;
  logPrefix: string;
  /** Temporary per-run files outside the project, removed after the run. */
  scratch: string[];
}

function invocation(plan: Omit<DispatchPlan, "program" | "args" | "scratch" | "env">): Pick<DispatchPlan, "program" | "args" | "scratch" | "env"> {
  const model = plan.model;
  // A pinned server refuses to receive any other request.
  const server = { command: process.execPath, args: [waiccCli(), "--root", plan.root, "mcp", "--session", plan.sessionId, "--request", plan.requestId] };
  switch (plan.via) {
    case "claude": {
      const config = join(tmpdir(), `waicc-dispatch-${plan.dispatchId}.json`);
      writeFileSync(config, json({ mcpServers: { waicc: server } }));
      return {
        program: "claude",
        args: [
          "-p", plan.prompt, "--output-format", "json",
          "--mcp-config", config, "--strict-mcp-config",
          "--allowedTools", "mcp__waicc,Read,Grep,Glob",
          "--disallowedTools", "Edit,Write,NotebookEdit,Bash",
          ...(model ? ["--model", model] : []),
        ],
        scratch: [config], env: {},
      };
    }
    case "codex":
      return {
        program: "codex",
        args: [
          "exec", "--sandbox", "read-only", "--skip-git-repo-check", "-C", plan.root,
          "-c", `mcp_servers.waicc.command=${JSON.stringify(server.command)}`,
          "-c", `mcp_servers.waicc.args=${JSON.stringify(server.args)}`,
          // Headless exec rejects unapproved MCP calls; approve only the four recipient tools.
          "-c", `mcp_servers.waicc.enabled_tools=${JSON.stringify(recipientTools)}`,
          "-c", 'mcp_servers.waicc.default_tools_approval_mode="approve"',
          ...(model ? ["-m", model] : []),
          plan.prompt,
        ],
        scratch: [], env: {},
      };
    case "agy":
      // agy reads MCP servers from its own config; see README for the one-time setup.
      return {
        program: "agy",
        args: [
          "-p", plan.prompt, "--output-format", "json", "--sandbox",
          "--print-timeout", `${Math.ceil(plan.timeoutMs / 60_000)}m`,
          ...(model ? ["--model", model] : []),
        ],
        scratch: [], env: {},
      };
    case "pi": {
      // Pi loads WAICC itself and pins the request at startup; recipient mode limits its tools.
      // Print mode does not run extension slash commands, so no /waicc-receive here.
      const implement = plan.mode === "implementation";
      const work = implement
        ? "implement the whole assignment in dependency order, editing only the task's allowed paths. You cannot run shell commands: report every check you could not run as not_run with that limit, and include whole-work completion evidence."
        : "do only that assignment with read-only tools.";
      return {
        program: "pi",
        args: [
          "-p", "--no-session", "-ne", "-e", extensionEntry(), "-a",
          ...(model ? ["--model", model] : []),
          `You are a dispatched WAICC ${plan.mode} recipient, not the coordinator. Your request is already pinned: call waicc_status to read the assignment, then ${work} Check your draft with waicc_reply and validateOnly true, fix every reported problem, submit exactly once with waicc_reply, then stop. If WAICC refuses, stop and explain why.`,
        ],
        scratch: [], env: { [dispatchPinVariable]: `${plan.sessionId}:${plan.requestId}${implement ? ":implement" : ""}` },
      };
    }
  }
}

function unfinished(root: string, s: ReturnType<typeof loadSession>, dir: string): boolean {
  return Object.keys(s.artifacts)
    .filter((path) => path.startsWith(`${dir}/dispatch/`) && path.endsWith("/start.json"))
    .some((path) => {
      if (Object.hasOwn(s.artifacts, path.replace(/start\.json$/, "result.json"))) return false;
      const start = JSON.parse(artifact(root, s, path)) as { startedAt: string; timeoutMs: number };
      // A crashed coordinator leaves no result; the record expires after its own timeout.
      return Date.parse(start.startedAt) + start.timeoutMs + 120_000 > Date.now();
    });
}

/** Validates and records the start under the writer lock; one dispatched recipient per request. */
export function prepareDispatch(cwd: string, id: string, options: DispatchOptions): DispatchPlan {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    ensure(s.status !== "CLOSED", "Contract is closed; nothing to dispatch.");
    const waiting = s.rounds.filter((r) => r.status === "WAITING");
    ensure(waiting.length === 1, "Dispatch needs exactly one waiting handoff. Use /waicc-status.");
    const r = waiting[0];
    if (r.mode === "implementation") {
      ensure(options.implement, "This is an implementation handoff. Add --implement only if you authorize its assigned code edits.");
      // Only Pi's WAICC recipient mode blocks edits outside task paths as they happen.
      ensure(options.via === "pi", "Only --via pi can confine implementation edits to the task's allowed paths. Use Pi, or hand it off manually.");
    } else {
      ensure(!options.implement, "--implement applies only to an implementation handoff");
      ensure(
        dispatchModes.includes(r.mode),
        `Dispatch supports read-only ${dispatchModes.join("/")} handoffs and Pi implementation. Hand ${r.mode} work off manually; checks need interactive confirmation.`,
      );
    }
    const dir = roundDirectory(r);
    const replyPath = safePath(root, `${sessionRelative(s.id)}/${dir}/reply.json`);
    ensure(!existsSync(replyPath), "A reply already exists. Run /waicc-continue instead.");
    ensure(!unfinished(root, s, dir), "A dispatched recipient is still working on this request. Wait, or stop it first.");
    ensure(
      snapshot(root).fingerprint === r.source.fingerprint,
      "Source changed since this handoff was issued; the recipient would be refused. Prepare a fresh handoff.",
    );
    const dispatchId = randomUUID();
    const starter = join(root, sessionRelative(s.id), dir, "STARTER.txt");
    const base = {
      dispatchId, root, sessionId: s.id, requestId: r.id, mode: r.mode, via: options.via,
      model: options.model ?? null, timeoutMs: (options.timeoutMinutes ?? 30) * 60_000, replyPath,
      logPrefix: `${dir}/dispatch/${dispatchId}`,
      // One line: it travels as a command-line argument on every platform.
      prompt: `You are a dispatched WAICC ${r.mode} recipient, not the coordinator, for the project at ${JSON.stringify(root)}. First call the waicc_receive MCP tool with sessionId ${JSON.stringify(s.id)} and requestId ${JSON.stringify(r.id)}. Then read ${JSON.stringify(starter)} and the assignment inputs, and do only that assignment. Source is read-only: do not edit, create or delete files. Check your draft with waicc_validate_reply and fix every reported problem, submit exactly once with waicc_submit_reply, then stop. If the waicc tools are unavailable or refuse, stop and explain why; never write reply.json yourself.`,
    };
    const plan: DispatchPlan = { ...base, ...invocation(base) };
    commit(root, s, "dispatch.started", {
      [`${plan.logPrefix}/start.json`]: json({
        schemaVersion: 1, dispatchId, sessionId: s.id, requestId: r.id, mode: r.mode,
        via: plan.via, model: plan.model, program: plan.program, args: plan.args, env: plan.env,
        startedAt: now(), timeoutMs: plan.timeoutMs,
      }),
    });
    return plan;
  });
}

const tail = (text: string, limit = 24_000): string => (text.length > limit ? text.slice(-limit) : text);

export async function runDispatch(plan: DispatchPlan, run: AgentRunner = runAgent, signal?: AbortSignal) {
  const startedAt = Date.now();
  let result: AgentResult;
  try {
    result = await run(plan.program, plan.args, { cwd: plan.root, timeout: plan.timeoutMs, signal, env: plan.env });
  } catch (error) {
    result = { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1, killed: Boolean(signal?.aborted) };
  } finally {
    for (const path of plan.scratch) rmSync(path, { force: true });
  }
  const replySubmitted = existsSync(plan.replyPath);
  const report = {
    schemaVersion: 1, dispatchId: plan.dispatchId, sessionId: plan.sessionId, requestId: plan.requestId,
    mode: plan.mode, via: plan.via, model: plan.model, finishedAt: now(), durationMs: Date.now() - startedAt,
    code: result.code, killed: result.killed, replySubmitted,
    stdout: tail(result.stdout), stderr: tail(result.stderr),
    outputTruncated: result.stdout.length > 24_000 || result.stderr.length > 24_000,
  };
  const logPath = `${plan.logPrefix}/result.json`;
  const saved = withLock(plan.root, () => {
    const s = loadSession(plan.root, plan.sessionId);
    if (s.status === "CLOSED") return false; // Never append to closed history.
    commit(plan.root, s, "dispatch.finished", { [logPath]: json(report) });
    return true;
  });
  return {
    dispatched: true, via: plan.via, model: plan.model, sessionId: plan.sessionId, requestId: plan.requestId,
    replySubmitted, code: result.code, killed: result.killed, durationMs: report.durationMs,
    log: saved ? join(plan.root, sessionRelative(plan.sessionId), logPath) : null,
    nextAction: replySubmitted
      ? "A validated reply was submitted. Run /waicc-continue to assess it; dispatch did not assess, accept or advance the contract."
      : `No reply was submitted (exit ${result.code}${result.killed ? ", stopped" : ""}). The handoff is still waiting: read the log, then dispatch again, use another agent, or hand it off manually.`,
  };
}

export async function dispatch(cwd: string, id: string, options: DispatchOptions, run: AgentRunner = runAgent, signal?: AbortSignal) {
  return runDispatch(prepareDispatch(cwd, id, options), run, signal);
}

// cmd.exe metacharacters, escaped the way cross-spawn does for .cmd shims.
const meta = /([()\][%!^"`<>&|;, *?])/g;
function cmdArgument(arg: string): string {
  ensure(!/[\r\n]/.test(arg), "Arguments for a Windows command shim cannot contain line breaks");
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  // Shims re-parse %* once more, so escape twice.
  return quoted.replace(meta, "^$1").replace(meta, "^$1");
}

/** PATH lookup that, unlike spawn(), finds Windows .cmd shims (npm, Volta). */
export function windowsCommand(program: string, args: string[], env = process.env): { file: string; args: string[]; verbatim: boolean } {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const found = dirs.flatMap((dir) => exts.map((ext) => join(dir, program + ext.toLowerCase()))).find((path) => existsSync(path));
  ensure(found, `${program} was not found on PATH. Install it and sign in, then dispatch again.`);
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args, verbatim: false };
  const line = [found.replace(meta, "^$1"), ...args.map(cmdArgument)].join(" ");
  return { file: env.comspec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
  }
}

/** Default runner: no shell, stdin closed (agents otherwise wait on it), whole tree killed on timeout. */
export const runAgent: AgentRunner = (program, args, options) =>
  new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const command = process.platform === "win32" ? windowsCommand(program, args) : { file: program, args, verbatim: false };
    const child = spawn(command.file, command.args, {
      cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      windowsVerbatimArguments: command.verbatim, detached: process.platform !== "win32",
    });
    let stdout = "", stderr = "", killed = false;
    // Keep more than the report stores so truncation stays detectable.
    child.stdout.on("data", (chunk) => { stdout = tail(stdout + chunk, 48_000); });
    child.stderr.on("data", (chunk) => { stderr = tail(stderr + chunk, 48_000); });
    const stop = () => { killed = true; killTree(child.pid); };
    const timer = setTimeout(stop, options.timeout);
    options.signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ stdout, stderr, code: code ?? 1, killed });
    });
  });
