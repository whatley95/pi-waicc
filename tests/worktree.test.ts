import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { prepareDispatch, runDispatch, type AgentRunner } from "../src/dispatch.ts";
import { loadSession } from "../src/files.ts";
import { mcpServer } from "../src/mcp.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { assess, createSession, delegateWork, ingest, prepare } from "../src/workflow.ts";
import { removeIsolation } from "../src/worktree.ts";
import type { Contract } from "../src/types.ts";

const contract: Contract = {
  title: "Search",
  requirements: [{ id: "REQ-001", text: "Add search", sourceQuote: "Add search" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: ["wai-node"],
  tasks: [{
    id: "SEARCH", title: "Add search", requirementIds: ["REQ-001"], dependsOn: [], allowedPaths: ["source.txt"],
    acceptance: [{ id: "AC-001", text: "Return expected results", requirementIds: ["REQ-001"], verification: "Exercise search cases" }],
  }],
};
const body = (outcome = "ready") => ({
  outcome, summary: "Implemented search; delivery unverified.",
  coverage: [{ requirementId: "REQ-001", status: "addressed", evidence: "source.txt implements AC-001" }],
  findings: [], questions: [],
  checks: [{ description: "Run search tests", outcome: "not_run", evidence: "No shell in this recipient" }],
});
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8", windowsHide: true });

/** A Git project whose delegated implementation handoff is waiting, with uncommitted and untracked work. */
function project(t: TestContext, setup: (root: string) => void = () => {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "waicc-test-")));
  writeFileSync(join(root, "committed.txt"), "committed\n");
  setup(root);
  git(root, "init", "--quiet");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "base");
  writeFileSync(join(root, "committed.txt"), "edited but not committed\n");
  writeFileSync(join(root, "source.txt"), "untracked source\n");
  const s = createSession(root, "Add search");
  prepare(root, s.id, contract, "planning", "Inspect search", 0);
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, body("planned"));
  const received = ingest(root, s.id);
  assess(root, s.id, { requestId: received.rounds.at(-1)!.id, decision: "planned", rationale: "Source checked", dispositions: [] });
  delegateWork(root, s.id, "implementation", "Implement everything");
  const plans: { isolation: { worktree: string } | null }[] = [];
  t.after(() => {
    for (const plan of plans) if (plan.isolation && existsSync(plan.isolation.worktree)) removeIsolation(root, plan.isolation as never);
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  const id = s.id;
  return { root, id, requestId: loadSession(root, id).rounds.at(-1)!.id, track: <T extends { isolation: { worktree: string } | null }>(plan: T) => (plans.push(plan), plan) };
}
/** A coding agent: receives first (as waicc_receive does), edits its working directory, then submits. */
const agent = (root: string, id: string, edit: (cwd: string) => void, submit = true): AgentRunner => async (_program, _args, options) => {
  const { pin } = receiveHandoff(root, id, true);
  edit(options.cwd);
  if (submit) submitRecipientReply(root, pin, {
    ...body(),
    completion: { summary: "All planned work complete", tasks: [{ taskId: "SEARCH", evidence: "source.txt implements AC-001" }], checks: body().checks, findings: [] },
  });
  return { stdout: "done", stderr: "", code: 0, killed: false };
};

test("Claude and Codex code in an isolated worktree of the exact handoff source; the checkout and index stay untouched", async (t) => {
  const { root, id, track } = project(t);
  const index = git(root, "ls-files", "--stage");
  const status = git(root, "status", "--porcelain");
  for (const via of ["claude", "codex"] as const) {
    const plan = track(prepareDispatch(root, id, { via, implement: true }));
    assert.ok(plan.isolation && plan.cwd === plan.isolation.worktree);
    // Claude Code refuses edits under Windows 8.3 short names (C:\Users\NAME~1).
    assert.doesNotMatch(plan.cwd, /~\d/);
    // The copy holds uncommitted and untracked work, exactly as the handoff saw it.
    assert.equal(readFileSync(join(plan.cwd, "committed.txt"), "utf8"), "edited but not committed\n");
    assert.equal(readFileSync(join(plan.cwd, "source.txt"), "utf8"), "untracked source\n");
    assert.equal(existsSync(join(plan.cwd, ".pi")), false, "WAICC state is not copied");
    const line = plan.args.join(" ");
    if (via === "claude") assert.ok(line.includes("--permission-mode acceptEdits") && line.includes("--disallowedTools Bash,NotebookEdit"));
    if (via === "codex") assert.ok(line.includes("--sandbox workspace-write") && line.includes(`-C ${plan.cwd}`));
    const server = via === "claude"
      ? JSON.parse(readFileSync(plan.args[plan.args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.waicc.args
      : JSON.parse(plan.args.find((arg) => arg.startsWith("mcp_servers.waicc.args="))!.slice("mcp_servers.waicc.args=".length));
    assert.equal(server.at(-1), "--implement", "the pinned server may receive implementation");
    assert.match(plan.prompt, /isolated copy/);
    removeIsolation(root, plan.isolation!);
    for (const path of plan.scratch) rmSync(path, { force: true });
    // Release this request's one-dispatch slot for the next agent.
    const s = loadSession(root, id);
    assert.ok(Object.keys(s.artifacts).some((path) => path.endsWith(`${plan.dispatchId}/start.json`)));
    await runDispatch({ ...plan, isolation: null }, async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
  }
  assert.equal(git(root, "ls-files", "--stage"), index, "the user's index is untouched");
  assert.equal(git(root, "status", "--porcelain"), status);
  assert.throws(() => prepareDispatch(root, id, { via: "agy", implement: true }), /Antigravity is not supported for implementation/);
});

test("in-scope isolated work is applied to the checkout and its worktree removed", async (t) => {
  const { root, id, track } = project(t);
  const plan = track(prepareDispatch(root, id, { via: "codex", implement: true }));
  const outcome = await runDispatch(plan, agent(root, id, (cwd) => writeFileSync(join(cwd, "source.txt"), "implemented search\n")));
  assert.equal(outcome.isolation?.applied, true, outcome.isolation?.reason ?? "");
  assert.deepEqual(outcome.isolation?.changes, [{ status: "M", path: "source.txt" }]);
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "implemented search\n");
  assert.equal(readFileSync(join(root, "committed.txt"), "utf8"), "edited but not committed\n");
  assert.equal(existsSync(plan.isolation!.worktree), false);
  assert.match(outcome.nextAction, /1 changed file\(s\) were applied/);
  assert.equal(ingest(root, id).status, "AWAITING_ASSESSMENT");
});

test("isolated work is applied all or nothing and the copy is kept for inspection", async (t) => {
  const cases: [string, (root: string) => (cwd: string) => void, boolean, RegExp][] = [
    ["outside the task paths", () => (cwd) => {
      writeFileSync(join(cwd, "source.txt"), "implemented\n");
      writeFileSync(join(cwd, "committed.txt"), "changed by agent\n");
    }, true, /committed\.txt is outside the task's allowed paths/],
    ["checkout changed meanwhile", (root) => (cwd) => {
      writeFileSync(join(cwd, "source.txt"), "implemented\n");
      writeFileSync(join(root, "committed.txt"), "the human kept working\n");
    }, true, /checkout changed while the agent worked/],
    ["no reply", () => (cwd) => writeFileSync(join(cwd, "source.txt"), "implemented\n"), false, /submitted no reply/],
  ];
  for (const [name, edit, submit, reason] of cases) {
    const { root, id, track } = project(t);
    const before = readFileSync(join(root, "source.txt"), "utf8");
    const plan = track(prepareDispatch(root, id, { via: "claude", implement: true }));
    const outcome = await runDispatch(plan, agent(root, id, edit(root), submit));
    assert.equal(outcome.isolation?.applied, false, name);
    assert.match(outcome.isolation!.reason!, reason, name);
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), before, `${name}: nothing applied`);
    assert.ok(existsSync(plan.isolation!.worktree), `${name}: copy kept`);
    assert.equal(readFileSync(join(plan.isolation!.worktree, "source.txt"), "utf8"), "implemented\n");
    assert.match(outcome.nextAction, submit ? /NOT applied/ : /nothing was applied/, name);
  }
});

test("an isolated MCP server receives implementation and reads only the assignment's inputs", async (t) => {
  const { root, id, requestId } = project(t);
  const call = async (handle: ReturnType<typeof mcpServer>, name: string, args: object) =>
    ((await handle({ id: 1, method: "tools/call", params: { name, arguments: args } })) as any).result;
  assert.equal((await call(mcpServer(root, { sessionId: id, requestId }), "waicc_receive", { sessionId: id, requestId })).isError, true);
  const isolated = mcpServer(root, { sessionId: id, requestId, implement: true });
  const assignment = JSON.parse((await call(isolated, "waicc_receive", { sessionId: id, requestId })).content[0].text);
  assert.match((await call(isolated, "waicc_read_input", { path: assignment.inputs.handoff })).content[0].text, /implementation/i);
  const outside = await call(isolated, "waicc_read_input", { path: join(root, "committed.txt") });
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /Only paths listed/);
});

test("ignored dependency folders are linked into the copy, never applied, and survive its removal", async (t) => {
  const { root, id, track } = project(t, (dir) => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  });
  const plan = track(prepareDispatch(root, id, { via: "codex", implement: true }));
  assert.deepEqual(plan.isolation!.linked, ["node_modules"]);
  assert.equal(readFileSync(join(plan.cwd, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
  assert.match(plan.prompt, /linked from the project/);
  const outcome = await runDispatch(plan, agent(root, id, (cwd) => {
    writeFileSync(join(cwd, "source.txt"), "implemented\n");
    // Writes through the link land in the project's own folder; they are not the agent's work.
    writeFileSync(join(cwd, "node_modules", "dep", "cache.txt"), "test cache\n");
  }));
  assert.equal(outcome.isolation?.applied, true, outcome.isolation?.reason ?? "");
  assert.deepEqual(outcome.isolation?.changes, [{ status: "M", path: "source.txt" }]);
  assert.equal(existsSync(plan.isolation!.worktree), false);
  // Removing the copy removed only the link: the project's dependencies are intact.
  assert.equal(readFileSync(join(root, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
  assert.ok(lstatSync(join(root, "node_modules")).isDirectory());
});

test("an unignored folder is not linked, and approved checks run inside the isolated copy", async (t) => {
  const { root, id, requestId, track } = project(t, (dir) => {
    mkdirSync(join(dir, "venv"));
    writeFileSync(join(dir, "venv", "marker.txt"), "tracked\n");
  });
  const whereAmI = { program: process.execPath, args: ["-e", "console.log(process.cwd())"], timeoutMs: 60_000 };
  const plan = track(prepareDispatch(root, id, { via: "codex", implement: true, checks: [whereAmI] }));
  assert.deepEqual(plan.isolation!.linked, [], "venv is not ignored, so it is not linked");
  const server = JSON.parse(plan.args.find((arg) => arg.startsWith("mcp_servers.waicc.args="))!.slice("mcp_servers.waicc.args=".length));
  assert.equal(server[server.indexOf("--check-cwd") + 1], plan.cwd);
  const handle = mcpServer(root, { sessionId: id, requestId, implement: true, checks: [whereAmI], checkCwd: plan.cwd });
  const call = async (name: string, args: object) => ((await handle({ id: 1, method: "tools/call", params: { name, arguments: args } })) as any).result;
  await call("waicc_receive", { sessionId: id, requestId });
  const ran = JSON.parse((await call("waicc_run_check", { check: 0 })).content[0].text);
  assert.equal(ran.outcome, "passed");
  assert.equal(ran.ranIn, "isolated worktree");
  assert.equal(realpathSync(ran.stdout.trim()), realpathSync(plan.cwd));
});
