import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
function project(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "waicc-test-")));
  writeFileSync(join(root, "committed.txt"), "committed\n");
  git(root, "init", "--quiet");
  git(root, "add", "committed.txt");
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

test("an isolated MCP server receives implementation and reads only the assignment's inputs", (t) => {
  const { root, id, requestId } = project(t);
  const call = (handle: ReturnType<typeof mcpServer>, name: string, args: object) =>
    (handle({ id: 1, method: "tools/call", params: { name, arguments: args } }) as any).result;
  assert.equal(call(mcpServer(root, { sessionId: id, requestId }), "waicc_receive", { sessionId: id, requestId }).isError, true);
  const isolated = mcpServer(root, { sessionId: id, requestId, implement: true });
  const assignment = JSON.parse(call(isolated, "waicc_receive", { sessionId: id, requestId }).content[0].text);
  assert.match(call(isolated, "waicc_read_input", { path: assignment.inputs.handoff }).content[0].text, /implementation/i);
  const outside = call(isolated, "waicc_read_input", { path: join(root, "committed.txt") });
  assert.equal(outside.isError, true);
  assert.match(outside.content[0].text, /Only paths listed/);
});
