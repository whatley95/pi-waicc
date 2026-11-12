import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, type AgentRunner } from "./dispatch.ts";
import { runtimePath } from "./files.ts";
import { loadAgentConfig, type AgentConfig, type AgentProfile } from "./profiles.ts";
import { receiveHandoff, submitRecipientReply } from "./recipient.ts";
import { projectRoot } from "./source.ts";
import type { Contract, Mode } from "./types.ts";
import { assess, beginDevelopment, closeSession, createSession, ingest, issue, prepare } from "./workflow.ts";

/** One line of /waicc-test: ok, a warning that stops nothing, or a failure to fix. */
export interface TestLine { check: string; result: "ok" | "warn" | "fail"; detail: string }
export interface TestReport { ok: boolean; checks: TestLine[] }

const minimumNode = [22, 19];
/** The roles a handoff dispatches to without --via; the others are optional. */
const neededRoles: Mode[] = ["planning", "review"];
const optionalRoles: Mode[] = ["advisor", "implementation", "testing"];
const pingPrompt = "This is a connection test. Reply with exactly the word OK and nothing else. Do not use any tools.";
const pingMs = 180_000;

/**
 * /waicc-test: every link WAICC needs, checked here and now, each failure with its error.
 * With models true, each role's agent is also asked one short question, so a model that is
 * not signed in, not installed or misnamed shows up before a real handoff does.
 */
export async function selfTest(cwd: string, options: { models?: boolean; runner?: AgentRunner } = {}): Promise<TestReport> {
  const checks: TestLine[] = [];
  const add = (check: string, result: TestLine["result"], detail: string) => checks.push({ check, result, detail });
  const attempt = async (check: string, run: () => Promise<string> | string) => {
    try {
      add(check, "ok", await run());
    } catch (error) {
      add(check, "fail", message(error));
    }
  };

  await attempt("Node.js", () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < minimumNode[0] || (major === minimumNode[0] && minor < minimumNode[1]))
      throw new Error(`Node.js ${process.versions.node} is too old: WAICC needs ${minimumNode.join(".")} or later on your PATH`);
    return `${process.versions.node} (${process.execPath})`;
  });

  await attempt("Project folder", () => {
    const root = projectRoot(cwd);
    const state = join(root, runtimePath);
    mkdirSync(state, { recursive: true });
    const probe = join(state, `.waicc-test-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return `${root} (WAICC's state can be written)`;
  });

  let config: AgentConfig | null = null;
  await attempt("Agent settings", () => {
    config = loadAgentConfig(cwd);
    const files = [config.files.found.includes("user") && config.files.user, config.files.found.includes("project") && config.files.project].filter(Boolean);
    return files.length ? `read ${files.join(" and ")}` : `no settings file yet: /waicc-dispatch --init-profiles creates ${config.files.user}`;
  });

  const used = new Map<string, AgentProfile>();
  if (config) {
    const c: AgentConfig = config;
    for (const role of [...neededRoles, ...optionalRoles]) {
      const choice = c.roles[role];
      const needed = neededRoles.includes(role);
      if (!choice) {
        add(`Role ${role}`, needed ? "fail" : "warn", `not set: ${needed ? "/waicc-dispatch needs a profile name or --via for this handoff" : "optional"}; set roles.${role} in ${c.files.user}`);
        continue;
      }
      const profile = c.profiles[choice.profile];
      if (!profile) {
        add(`Role ${role}`, "fail", `profile ${choice.profile} does not exist in your settings`);
        continue;
      }
      used.set(choice.profile, profile);
      add(`Role ${role}`, "ok", `${choice.profile} = ${profile.via}${profile.model ? ` ${profile.model}` : ""}${profile.effort ? `, effort ${profile.effort}` : ""}`);
    }
    for (const via of new Set([...used.values()].map((p) => p.via)))
      await attempt(`Program ${via}`, () => onPath(via));
  }

  await attempt("Tool server", () => toolServer(cwd));
  await attempt("Planning and review", () => dryRun());

  if (options.models !== false && used.size) {
    const runner = options.runner ?? runAgent;
    const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
    try {
      const results = await Promise.all([...used].map(async ([name, profile]) => {
        try {
          return { name, line: { check: `Model ${name}`, result: "ok" as const, detail: await ping(runner, profile, scratch) } };
        } catch (error) {
          return { name, line: { check: `Model ${name}`, result: "fail" as const, detail: message(error) } };
        }
      }));
      for (const { line } of results) checks.push(line);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  return { ok: !checks.some((c) => c.result === "fail"), checks };
}

/** The report as lines for the human: one per check, each failure with what to do. */
export function selfTestText(report: TestReport): string {
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  const lines = report.checks.map((c) => `${mark[c.result]} ${c.check}: ${c.detail}`);
  const failed = report.checks.filter((c) => c.result === "fail").length;
  lines.push(failed ? `${failed} check${failed > 1 ? "s" : ""} failed.` : "Everything WAICC needs works.");
  return lines.join("\n");
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 600);
}

/** Where a program is on PATH (on Windows with its extension, as .cmd shims are found too). */
function onPath(program: string): string {
  const windows = process.platform === "win32";
  const exts = windows ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase()) : [""];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter).filter(Boolean))
    for (const ext of exts) {
      const path = join(dir, program + ext);
      try {
        accessSync(path, windows ? constants.F_OK : constants.X_OK);
        return path;
      } catch { /* not here */ }
    }
  throw new Error(`${program} was not found on PATH. Install it and sign in.`);
}

/** Starts the main agent's tool server as Claude Code does and lists its tools. */
function toolServer(cwd: string): Promise<string> {
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const wanted = ["waicc_status", "waicc_prepare", "waicc_assess", "waicc_context"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--root", projectRoot(cwd), "mcp", "--coordinator"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const started = Date.now();
    let out = "", err = "";
    const finish = (error: Error | null, text = "") => {
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(text);
    };
    const timer = setTimeout(() => finish(new Error(`no answer within 20 s${err ? `: ${err.trim()}` : ""}`)), 20_000);
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(new Error(`it exited with ${code}${err ? `: ${err.trim()}` : ""}`)));
    child.stdout.on("data", (d) => {
      out += d;
      for (const line of out.split("\n").slice(0, -1)) {
        let reply: any;
        try { reply = JSON.parse(line); } catch { continue; }
        if (reply.error) return finish(new Error(reply.error.message));
        if (reply.id === 1) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
        if (reply.id === 2) {
          const names: string[] = (reply.result?.tools ?? []).map((t: { name: string }) => t.name);
          const missing = wanted.filter((name) => !names.includes(name));
          return missing.length
            ? finish(new Error(`it lacks ${missing.join(", ")}`))
            : finish(null, `started and listed ${names.length} tools in ${Date.now() - started} ms`);
        }
      }
      out = out.slice(out.lastIndexOf("\n") + 1);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "waicc-test", version: "1" } } })}\n`);
  });
}

/** A whole session in a throwaway folder: plan, reply, accept, develop, code review, close. No model is asked. */
function dryRun(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  try {
    mkdirSync(join(root, runtimePath), { recursive: true });
    writeFileSync(join(root, "hello.txt"), "before");
    const contract: Contract = {
      title: "Self-test", requirements: [{ id: "R1", text: "Say hello", sourceQuote: "Say hello" }],
      exclusions: [], assumptions: [], risks: [], questions: [], skills: [],
      tasks: [{ id: "T1", title: "Write hello", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["hello.txt"],
        acceptance: [{ id: "AC1", text: "hello.txt says hello", requirementIds: ["R1"], verification: "Read hello.txt" }] }],
    };
    const reply = (id: string, outcome: "planned" | "ready") => {
      const a = receiveHandoff(root, id);
      submitRecipientReply(root, a.pin, { outcome, summary: "Self-test reply", coverage: [{ requirementId: "R1", status: "addressed", evidence: "hello.txt" }],
        findings: [], questions: [], checks: [{ description: "Read hello.txt", outcome: "not_run", evidence: "Self-test" }] });
      return ingest(root, id);
    };
    let s = createSession(root, "Say hello", undefined, "planning");
    s = prepare(root, s.id, contract, "planning", "Plan the self-test", 0);
    s = reply(s.id, "planned");
    s = assess(root, s.id, { requestId: s.rounds.at(-1)!.id, decision: "planned", rationale: "Self-test plan", dispositions: [] });
    s = beginDevelopment(root, s.id);
    writeFileSync(join(root, "hello.txt"), "hello");
    s = issue(root, s.id, "review", "Review the self-test change", undefined, undefined, { kind: "code", completion: {
      summary: "Self-test change", tasks: [{ taskId: "T1", evidence: "hello.txt says hello" }],
      checks: [{ description: "Read hello.txt", outcome: "not_run", evidence: "Self-test" }], findings: [] } });
    s = reply(s.id, "ready");
    s = assess(root, s.id, { requestId: s.rounds.at(-1)!.id, decision: "ready", rationale: "Self-test review", dispositions: [] });
    s = closeSession(root, s.id, "Self-test done");
    if (s.status !== "CLOSED") throw new Error(`the throwaway session ended ${s.status}, not CLOSED`);
    return "a throwaway session went through planning, development and code review to closed";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** One short question to a profile's agent, with its model and effort: what it answered, or why it failed. */
async function ping(runner: AgentRunner, p: AgentProfile, cwd: string): Promise<string> {
  const model = p.model ? ["--model", p.model] : [];
  const args: Record<AgentProfile["via"], string[]> = {
    claude: ["-p", pingPrompt, "--strict-mcp-config", "--disallowedTools", "Bash,Edit,Write,NotebookEdit", ...model, ...(p.effort ? ["--effort", p.effort] : [])],
    codex: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-C", cwd, ...(p.model ? ["-m", p.model] : []), ...(p.effort ? ["-c", `model_reasoning_effort="${p.effort}"`] : []), pingPrompt],
    agy: ["-p", pingPrompt, "--sandbox", "--print-timeout", "3m", ...model, ...(p.effort ? ["--effort", p.effort] : [])],
    pi: ["-p", "--no-session", "-ne", ...model, ...(p.effort ? ["--thinking", p.effort] : []), pingPrompt],
  };
  const started = Date.now();
  const ran = await runner(p.via, args[p.via], { cwd, timeout: pingMs });
  const said = ran.stdout.trim();
  if (ran.killed) throw new Error(`no answer within ${pingMs / 1000} s`);
  if (ran.code !== 0) throw new Error(`${p.via} exited with ${ran.code}: ${(ran.stderr.trim() || said).slice(-400)}`);
  if (!/\bOK\b/i.test(said)) throw new Error(`${p.via} answered, but not OK: ${said.slice(-200) || "(nothing)"}`);
  return `answered in ${Math.round((Date.now() - started) / 1000)} s`;
}
