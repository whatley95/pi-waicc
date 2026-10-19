import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifact, json, loadSession, now, safePath, sessionRelative, withLock } from "./files.ts";
import { commitWithCheckpoint as commit } from "./checkpoint.ts";
import { checkCommand, type CheckCommand } from "./checks.ts";
import { roundDirectory } from "./render.ts";
import { projectRoot, snapshot } from "./source.ts";
import { ensure } from "./validation.ts";
import { applyIsolatedChanges, createIsolation, isolatedChanges, removeIsolation, type Isolation } from "./worktree.ts";
import type { Mode, RecipientPin } from "./types.ts";

export const agents = ["claude", "codex", "pi", "agy"] as const;
export type Agent = (typeof agents)[number];
/** Each agent's own effort or thinking levels; a model may support only some of them. */
export const effortLevels: Record<Agent, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  agy: ["low", "medium", "high"],
};
/** Roles whose recipient never edits source. Implementation needs --implement: Pi edits in place
 * within task paths; Claude and Codex edit an isolated worktree whose changes are checked first.
 * Testing needs at least one --check the human pre-approves. */
const dispatchModes: Mode[] = ["planning", "review", "advisor"];
const checkModes: Mode[] = ["implementation", "testing"];

export interface DispatchOptions {
  via: Agent;
  model?: string;
  /** Reasoning effort, passed as the agent's own setting (Claude --effort, Codex model_reasoning_effort, Pi --thinking). */
  effort?: string;
  timeoutMinutes?: number;
  /** Explicit opt-in for an implementation handoff. */
  implement?: boolean;
  /** Exact commands the human pre-approves; the agent can run only these, through WAICC. */
  checks?: CheckCommand[];
}
export interface AgentResult {
  stdout: string; stderr: string; code: number; killed: boolean;
}
export type AgentRunner = (program: string, args: string[], options: {
  cwd: string; timeout: number; signal?: AbortSignal; env?: Record<string, string>;
}) => Promise<AgentResult>;
/** Set by dispatch only: the Pi extension pins this request read-only at startup. */
export const dispatchPinVariable = "WAICC_DISPATCH_PIN";
/** Set by dispatch only: JSON list of the checks the human pre-approved for this run. */
export const dispatchChecksVariable = "WAICC_DISPATCH_CHECKS";

/** Splits options, keeping "double-quoted values" whole. */
const optionWords = (input: string): string[] => [...input.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
/** Splits one command into program and arguments, keeping 'single-quoted arguments' whole. */
const commandWords = (input: string): string[] => [...input.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
export const commandText = (command: CheckCommand): string =>
  [command.program, ...command.args].map((word) => (/\s/.test(word) ? `'${word}'` : word)).join(" ");

/** Dispatch arguments as typed. Every setting is optional so an agent profile can supply the rest. */
export interface DispatchArgs {
  /** A leading bare word names an agent profile. */
  profile?: string;
  options: Partial<DispatchOptions>;
  /** --check-timeout as typed; it also applies to checks a profile's role supplies. */
  checkMinutes?: number;
}

export function parseDispatchArgs(input: string | string[]): DispatchArgs {
  // The CLI passes its arguments as they are; Pi passes one line.
  const words = typeof input === "string" ? optionWords(input) : input;
  const options: Partial<DispatchOptions> = {};
  const commands: string[] = [];
  let checkMinutes: number | undefined;
  let profile: string | undefined;
  let first = 0;
  if (words[0] !== undefined && !words[0].startsWith("-")) {
    profile = words[0];
    ensure(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile), "Agent profile names use letters, digits, - and _");
    first = 1;
  }
  for (let i = first; i < words.length; i += 2) {
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
      options.model = modelName(value);
    } else if (flag === "--effort") {
      options.effort = effortName(value);
    } else if (flag === "--timeout") {
      options.timeoutMinutes = minutes(value, 120, "--timeout");
    } else if (flag === "--check") {
      commands.push(value);
    } else if (flag === "--check-timeout") {
      checkMinutes = minutes(value, 30, "--check-timeout");
    } else ensure(false, `Unknown dispatch option ${flag}`);
  }
  if (commands.length) options.checks = checkCommands(commands, checkMinutes);
  return { profile, options, checkMinutes };
}

/** Explicit settings only: --via is required and no agent profile is consulted. */
export function dispatchOptions(input: string | string[]): DispatchOptions {
  const { profile, options } = parseDispatchArgs(input);
  ensure(!profile && options.via, `Usage: --via ${agents.join("|")} [--model <model>] [--effort <level>] [--timeout <minutes>] [--implement] [--check "<command>"]... [--check-timeout <minutes>]`);
  return options as DispatchOptions;
}

export function modelName(value: unknown): string {
  ensure(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(value), "Invalid model name");
  return value;
}

export function effortName(value: unknown): string {
  ensure(typeof value === "string" && /^[a-z]{2,16}$/.test(value), "Invalid effort level");
  return value;
}

/** An effort level this agent accepts; the model may still reject levels it lacks. */
export function agentEffort(via: Agent, effort: string, label = "effort"): string {
  ensure(effortLevels[via].includes(effort), `${label} for ${via} must be one of ${effortLevels[via].join(", ")}`);
  return effort;
}

export function minutes(value: unknown, max: number, label: string): number {
  const count = Number(value);
  ensure(Number.isInteger(count) && count >= 1 && count <= max, `${label} must be 1–${max} minutes`);
  return count;
}

/** Each text is one exact command; single quotes group an argument with spaces. */
export function checkCommands(texts: string[], minutesEach = 10): CheckCommand[] {
  ensure(texts.length <= 10, "At most 10 --check commands");
  return texts.map((text) => {
    const [program, ...args] = commandWords(text);
    ensure(program, '--check needs a command, for example --check "npm test"');
    return checkCommand({ program, args, timeoutMs: minutesEach * 60_000 }, maxCheckMs);
  });
}
/** Pre-approved checks may run longer than interactive ones, which stop at one minute. */
export const maxCheckMs = 30 * 60_000;

const here = fileURLToPath(import.meta.url);
/** Same build as this module, except installed TypeScript: Node cannot strip types under node_modules. */
function waiccCli(): string {
  const compiled = join(dirname(dirname(here)), "dist", "cli.js");
  return extname(here) === ".ts" && /[\\/]node_modules[\\/]/.test(here) && existsSync(compiled)
    ? compiled
    : join(dirname(here), `cli${extname(here)}`);
}
const extensionEntry = (): string => join(dirname(here), `index${extname(here)}`);
const recipientTools = ["waicc_receive", "waicc_assignment", "waicc_read_input", "waicc_run_check", "waicc_validate_reply", "waicc_submit_reply"];

export interface DispatchPlan {
  dispatchId: string;
  root: string;
  sessionId: string;
  requestId: string;
  mode: Mode;
  via: Agent;
  model: string | null;
  effort: string | null;
  timeoutMs: number;
  pin: RecipientPin;
  /** Where the agent runs: the project, or its isolated worktree. */
  cwd: string;
  isolation: Isolation | null;
  checks: CheckCommand[];
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
  const effort = plan.effort;
  const isolated = plan.isolation !== null;
  // Approved checks travel in a file, not on a command line that would need quoting.
  const checksFile = plan.checks.length && plan.via !== "pi" ? join(tmpdir(), `waicc-checks-${plan.dispatchId}.json`) : null;
  if (checksFile) writeFileSync(checksFile, json(plan.checks));
  // A pinned server refuses to receive any other request; --implement only for an isolated copy.
  const server = {
    command: process.execPath,
    args: [
      waiccCli(), "--root", plan.root, "mcp", "--session", plan.sessionId, "--request", plan.requestId,
      ...(isolated ? ["--implement"] : []),
      ...(checksFile ? ["--checks", checksFile] : []),
      ...(checksFile && isolated ? ["--check-cwd", plan.cwd] : []),
    ],
  };
  const scratch = checksFile ? [checksFile] : [];
  switch (plan.via) {
    case "claude": {
      const config = join(tmpdir(), `waicc-dispatch-${plan.dispatchId}.json`);
      writeFileSync(config, json({ mcpServers: { waicc: server } }));
      return {
        program: "claude",
        args: [
          "-p", plan.prompt, "--output-format", "json",
          "--mcp-config", config, "--strict-mcp-config",
          // Coding: edits auto-accepted only inside the worktree it runs in; still no shell.
          ...(isolated
            ? ["--permission-mode", "acceptEdits", "--allowedTools", "mcp__waicc,Read,Grep,Glob,Edit,Write", "--disallowedTools", "Bash,NotebookEdit"]
            : ["--allowedTools", "mcp__waicc,Read,Grep,Glob", "--disallowedTools", "Edit,Write,NotebookEdit,Bash"]),
          ...(model ? ["--model", model] : []),
          ...(effort ? ["--effort", effort] : []),
        ],
        scratch: [config, ...scratch], env: {},
      };
    }
    case "codex":
      return {
        program: "codex",
        args: [
          // The OS sandbox limits writes to the directory it runs in: the project read-only, or the worktree.
          "exec", "--sandbox", isolated ? "workspace-write" : "read-only", "--skip-git-repo-check", "-C", plan.cwd,
          "-c", `mcp_servers.waicc.command=${JSON.stringify(server.command)}`,
          "-c", `mcp_servers.waicc.args=${JSON.stringify(server.args)}`,
          // Headless exec rejects unapproved MCP calls; approve only the four recipient tools.
          "-c", `mcp_servers.waicc.enabled_tools=${JSON.stringify(recipientTools)}`,
          "-c", 'mcp_servers.waicc.default_tools_approval_mode="approve"',
          ...(model ? ["-m", model] : []),
          ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
          plan.prompt,
        ],
        scratch, env: {},
      };
    case "agy":
      // agy reads MCP servers from its own config; see README for the one-time setup.
      return {
        program: "agy",
        args: [
          "-p", plan.prompt, "--output-format", "json", "--sandbox",
          "--print-timeout", `${Math.ceil(plan.timeoutMs / 60_000)}m`,
          ...(model ? ["--model", model] : []),
          ...(effort ? ["--effort", effort] : []),
        ],
        scratch: [], env: {},
      };
    case "pi": {
      // Pi loads WAICC itself and pins the request at startup; recipient mode limits its tools.
      // Print mode does not run extension slash commands, so no /waicc-receive here.
      const implement = plan.mode === "implementation";
      const checks = plan.checks.length
        ? ` You have no shell, but you may run exactly these pre-approved checks with waicc_check (program and args exactly as listed): ${plan.checks.map((check) => JSON.stringify({ program: check.program, args: check.args })).join(", ")}. Report each result with its log; mark any other check not_run with its limit.`
        : " You cannot run shell commands: report every check you could not run as not_run with that limit.";
      const work = implement
        ? `implement the whole assignment in dependency order, editing only the task's allowed paths.${checks} Include whole-work completion evidence.`
        : `do only that assignment with read-only tools.${plan.mode === "testing" ? checks : ""}`;
      return {
        program: "pi",
        args: [
          "-p", "--no-session", "-ne", "-e", extensionEntry(), "-a",
          ...(model ? ["--model", model] : []),
          ...(effort ? ["--thinking", effort] : []),
          `You are a dispatched WAICC ${plan.mode} recipient, not the coordinator. Your request is already pinned: call waicc_status to read the assignment, then ${work} Check your draft with waicc_reply and validateOnly true, fix every reported problem, submit exactly once with waicc_reply, then stop. If WAICC refuses, stop and explain why.`,
        ],
        scratch: [],
        env: {
          [dispatchPinVariable]: `${plan.sessionId}:${plan.requestId}${implement ? ":implement" : ""}`,
          ...(plan.checks.length ? { [dispatchChecksVariable]: json(plan.checks) } : {}),
        },
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
    if (options.effort) agentEffort(options.via, options.effort);
    const waiting = s.rounds.filter((r) => r.status === "WAITING");
    ensure(waiting.length === 1, "Dispatch needs exactly one waiting handoff. Use /waicc-status.");
    const r = waiting[0];
    if (r.mode === "implementation") {
      ensure(options.implement, "This is an implementation handoff. Add --implement only if you authorize its assigned code edits.");
      ensure(options.via !== "agy", "Antigravity is not supported for implementation yet. Use --via pi, claude or codex.");
    } else {
      ensure(!options.implement, "--implement applies only to an implementation handoff");
      ensure(
        dispatchModes.includes(r.mode) || (r.mode === "testing" && options.checks?.length),
        r.mode === "testing"
          ? "A testing handoff needs at least one pre-approved check: add --check \"<exact command>\" for each command the tester may run."
          : `Dispatch supports read-only ${dispatchModes.join("/")} handoffs, testing with --check, and --implement.`,
      );
    }
    const checks = options.checks ?? [];
    ensure(!checks.length || checkModes.includes(r.mode), "--check applies only to testing and implementation handoffs");
    ensure(!checks.length || options.via !== "agy", "Antigravity uses its own MCP configuration and cannot receive pre-approved checks.");
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
    const isolation = r.mode === "implementation" && options.via !== "pi" ? createIsolation(root, dispatchId) : null;
    const ids = `sessionId ${JSON.stringify(s.id)} and requestId ${JSON.stringify(r.id)}`;
    const finish = "Check your draft with waicc_validate_reply and fix every reported problem, submit exactly once with waicc_submit_reply, then stop. If the waicc tools are unavailable or refuse, stop and explain why; never write reply.json yourself.";
    const approved = checks.length
      ? `Run the pre-approved checks with waicc_run_check by number (${checks.map((check, i) => `${i}: ${commandText(check)}`).join("; ")}); WAICC runs them${isolation ? " in this copy" : ""} and logs each result. Cite those results; mark any other check not_run with its limit.`
      : "";
    const shell = options.via === "codex"
      ? "Shell commands run in a sandbox without network; ignored dependency folders such as node_modules are linked from the project when present."
      : "You have no shell.";
    const base = {
      dispatchId, root, sessionId: s.id, requestId: r.id, mode: r.mode, via: options.via,
      model: options.model ?? null, effort: options.effort ?? null, timeoutMs: (options.timeoutMinutes ?? 30) * 60_000, replyPath,
      pin: { sessionId: s.id, requestId: r.id, contractVersion: r.contractVersion, requirementsDigest: r.requirementsDigest, sourceFingerprint: r.source.fingerprint, mode: r.mode },
      cwd: isolation?.worktree ?? root, isolation, checks,
      logPrefix: `${dir}/dispatch/${dispatchId}`,
      // One line: it travels as a command-line argument on every platform.
      prompt: isolation
        ? `You are a dispatched WAICC implementation recipient, not the coordinator. You are working in an isolated copy of the project at ${JSON.stringify(isolation.worktree)}; the real checkout is not yours to edit. First call the waicc_receive MCP tool with ${ids}, then read its handoff and other inputs with waicc_read_input. Implement the whole assignment in dependency order in this copy, changing only files inside the task's allowedPaths: when you finish, WAICC applies your changes to the real checkout only if every changed file is in scope, and applies nothing otherwise. ${shell} ${approved} Report whole-work completion evidence and every check honestly, marking any check you could not run not_run with its limit. ${finish}`
        : `You are a dispatched WAICC ${r.mode} recipient, not the coordinator, for the project at ${JSON.stringify(root)}. First call the waicc_receive MCP tool with ${ids}. Then read ${JSON.stringify(starter)} and the assignment inputs, and do only that assignment. Source is read-only: do not edit, create or delete files. ${approved} ${finish}`,
    };
    try {
      const plan: DispatchPlan = { ...base, ...invocation(base) };
      commit(root, s, "dispatch.started", {
        [`${plan.logPrefix}/start.json`]: json({
          schemaVersion: 1, dispatchId, sessionId: s.id, requestId: r.id, mode: r.mode,
          via: plan.via, model: plan.model, effort: plan.effort, program: plan.program, args: plan.args, env: plan.env,
          isolation, checks, startedAt: now(), timeoutMs: plan.timeoutMs,
        }),
      });
      return plan;
    } catch (error) {
      if (isolation) removeIsolation(root, isolation);
      throw error;
    }
  });
}

/** Brings an isolated agent's work back, all or nothing; the worktree is kept whenever nothing is applied. */
function settleIsolation(plan: DispatchPlan, replySubmitted: boolean) {
  const isolation = plan.isolation!;
  let changes: ReturnType<typeof isolatedChanges> = [];
  try {
    changes = isolatedChanges(isolation);
    ensure(replySubmitted, "Nothing was applied: the agent submitted no reply.");
    withLock(plan.root, () => applyIsolatedChanges(plan.root, plan.pin, isolation, changes));
    removeIsolation(plan.root, isolation);
    return { applied: true, changes, worktree: null, reason: null };
  } catch (error) {
    return { applied: false, changes, worktree: isolation.worktree, reason: error instanceof Error ? error.message : String(error) };
  }
}

const tail = (text: string, limit = 24_000): string => (text.length > limit ? text.slice(-limit) : text);

export async function runDispatch(plan: DispatchPlan, run: AgentRunner = runAgent, signal?: AbortSignal) {
  const startedAt = Date.now();
  let result: AgentResult;
  try {
    result = await run(plan.program, plan.args, { cwd: plan.cwd, timeout: plan.timeoutMs, signal, env: plan.env });
  } catch (error) {
    result = { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1, killed: Boolean(signal?.aborted) };
  } finally {
    for (const path of plan.scratch) rmSync(path, { force: true });
  }
  const replySubmitted = existsSync(plan.replyPath);
  const isolation = plan.isolation ? settleIsolation(plan, replySubmitted) : null;
  const report = {
    schemaVersion: 1, dispatchId: plan.dispatchId, sessionId: plan.sessionId, requestId: plan.requestId,
    mode: plan.mode, via: plan.via, model: plan.model, effort: plan.effort, finishedAt: now(), durationMs: Date.now() - startedAt,
    code: result.code, killed: result.killed, replySubmitted, isolation,
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
    dispatched: true, via: plan.via, model: plan.model, effort: plan.effort, sessionId: plan.sessionId, requestId: plan.requestId,
    replySubmitted, code: result.code, killed: result.killed, durationMs: report.durationMs,
    isolation,
    log: saved ? join(plan.root, sessionRelative(plan.sessionId), logPath) : null,
    nextAction: isolation && !isolation.applied && replySubmitted
      ? `A reply was submitted but its code was NOT applied: ${isolation.reason} The agent's copy is kept at ${isolation.worktree}. Inspect it, then /waicc-cancel this handoff (the reply describes changes that are not in your checkout) or apply in-scope work yourself.`
      : replySubmitted
        ? `A validated reply was submitted${!isolation ? "" : isolation.changes.length ? ` and ${isolation.changes.length} changed file(s) were applied to your checkout` : ", but the agent changed no files; read its reply for why"}. Run /waicc-continue to assess it; dispatch did not assess, accept or advance the contract.`
        : `No reply was submitted (exit ${result.code}${result.killed ? ", stopped" : ""}). The handoff is still waiting${isolation ? ` and nothing was applied; the agent's copy is kept at ${isolation.worktree}` : ""}: read the log, then dispatch again, use another agent, or hand it off manually.`,
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
  // A path is used as given (with an implied extension); a bare name is looked up on PATH.
  const candidates = /[\\/]/.test(program)
    ? [program, ...exts.map((ext) => program + ext.toLowerCase())]
    : dirs.flatMap((dir) => exts.map((ext) => join(dir, program + ext.toLowerCase())));
  const found = candidates.find((path) => existsSync(path) && extname(path) !== "");
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
