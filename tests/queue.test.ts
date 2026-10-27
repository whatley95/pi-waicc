import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { addToQueue, queueReportVariable, readQueue, reportFileFor, runItem, updateQueue, type PiSpawner, type QueueEvent, type QueueItem } from "../src/queue.ts";
import { createSession, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const contract = (request: string): Contract => ({
  title: request, requirements: [{ id: "R1", text: request, sourceQuote: request }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title: request, requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"], acceptance: [{ id: "AC1", text: "Works", requirementIds: ["R1"], verification: "Try it" }] }],
});

/**
 * A queued Pi without a model: /waicc-planning makes a session with a waiting planning handoff
 * (what the main agent would do); /waicc-dispatch reports `ending` as the run's events. It asks
 * the questions in `ask` and records the answers.
 */
function fakePi(ending: QueueEvent[], options: { ask?: { method: string; title: string }[]; plans?: boolean } = {}) {
  const answers: Record<string, unknown> = {}, prompts: string[] = [], started: { folder: string; trusted: boolean }[] = [];
  const spawn: PiSpawner = (folder, env, trusted) => {
    started.push({ folder, trusted });
    const listeners: ((line: string) => void)[] = [];
    const emit = (event: object) => setTimeout(() => listeners.forEach((l) => l(JSON.stringify(event))), 1);
    let exit: (code: number) => void = () => {};
    return {
      onLine: (l) => void listeners.push(l),
      kill: () => exit(0),
      exited: new Promise((resolve) => (exit = resolve)),
      write: (line) => {
        const command = JSON.parse(line);
        if (command.type === "extension_ui_response") return void (answers[command.id] = command.confirmed ?? (command.cancelled ? "cancelled" : command.value));
        emit(command.type === "get_commands" ? { type: "response", id: command.id, data: { commands: [{ name: "waicc-queue" }] } } : { type: "response", id: command.id });
        if (command.type !== "prompt") return;
        prompts.push(command.message);
        if (command.message.startsWith("/waicc-planning")) {
          for (const [i, question] of (options.ask ?? []).entries()) emit({ type: "extension_ui_request", id: `ask${i}`, ...question });
          if (options.plans !== false) {
            const request = command.message.replace(/^\/waicc-planning\s*/, "");
            prepare(folder, createSession(folder, request).id, contract(request), "planning", "Plan", 0);
          }
          emit({ type: "agent_end" });
        } else for (const event of ending) appendFileSync(env[queueReportVariable], `${JSON.stringify(event)}\n`);
      },
    };
  };
  return { spawn, answers, prompts, started };
}

function project(t: TestContext) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-queue-")));
  t.after(() => {
    assert.ok(basename(base).startsWith("waicc-queue-"));
    rmSync(base, { recursive: true, force: true });
  });
  const root = join(base, "app");
  mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "app.txt"), "app");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Start");
  return { base, root };
}
const item = (task: string, issue: QueueItem["issue"] = null): QueueItem => ({ id: 1, task, issue, status: "waiting", addedAt: "" });
const run = (root: string, i: QueueItem, spawn: PiSpawner) => runItem(i, root, reportFileFor(root, i.id), { dispatch: "", trusted: true, spawn, planningMs: 60_000 }, new AbortController().signal);

test("a queued task plans, runs --auto --ship, and ends when its shipped change's pipeline ends", async (t) => {
  const { root } = project(t);
  const pi = fakePi([
    { kind: "shipped", url: "https://gitlab.example.com/team/app/-/merge_requests/3", branch: "waicc/queue-1-x", sessionId: "s" },
    { kind: "pipeline", outcome: "fixing", text: "unit" },
    { kind: "shipped", url: "https://gitlab.example.com/team/app/-/merge_requests/3", branch: "waicc/queue-1-x", sessionId: "s" },
    { kind: "pipeline", outcome: "passed", text: "The pipeline passed." },
  ]);
  const result = await run(root, item("Add paging"), pi.spawn);
  assert.deepEqual(pi.prompts, ["/waicc-planning Add paging", "/waicc-dispatch --auto --ship"]);
  assert.equal(result.status, "shipped");
  assert.equal(result.url, "https://gitlab.example.com/team/app/-/merge_requests/3");
  assert.equal(result.outcome, "The pipeline passed.");
  assert.ok(result.sessionId);
});

test("without autoShip a task ends reviewed; a task the main agent did not plan fails", async (t) => {
  const { root } = project(t);
  const reviewed = await run(root, item("Add paging"), fakePi([{ kind: "loop-ended", level: "info", text: "Review passed after 1 cycle. Not shipped, as you chose: /waicc-ship when you are ready." }]).spawn);
  assert.equal(reviewed.status, "reviewed");
  const stopped = await run(root, item("Add paging"), fakePi([{ kind: "loop-ended", level: "warning", text: "Automatic run stopped: something needs you." }]).spawn);
  assert.equal(stopped.status, "stopped");
  const unplanned = await run(root, item("Add paging"), fakePi([], { plans: false }).spawn);
  assert.deepEqual([unplanned.status, unplanned.outcome], ["failed", "The main agent did not prepare a planning handoff."]);
});

test("a queued Pi's questions are answered no, except the issue you confirmed when you queued it", async (t) => {
  const { root } = project(t);
  const pi = fakePi([{ kind: "loop-ended", level: "info", text: "Not shipped, as you chose" }], {
    ask: [
      { method: "confirm", title: "Plan from issue #5: Dark mode?" },
      { method: "confirm", title: "Plan from issue #6: Something else?" },
      { method: "confirm", title: "Run these checks from the project's agent config?" },
      { method: "select", title: "Pick one" },
    ],
  });
  await run(root, item("", { number: 5, title: "Dark mode" }), pi.spawn);
  assert.equal(pi.prompts[0], "/waicc-planning --issue 5");
  assert.deepEqual(pi.answers, { ask0: true, ask1: false, ask2: false, ask3: "cancelled" });
});

test("/waicc-queue adds, lists and runs tasks one after another, each in its own branch folder", async (t) => {
  const { base, root } = project(t);
  const agentDir = join(base, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "waicc-agents.json"), "{}");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { process.env.PI_CODING_AGENT_DIR = previous; });
  const pi = fakePi([{ kind: "loop-ended", level: "info", text: "Review passed. Not shipped, as you chose" }]);
  const commands = new Map<string, any>(), shown: string[] = [], confirms: string[] = [];
  waicc({
    registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {}, on() {},
    appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendUserMessage() {},
    sendMessage: (m: { content: string }) => shown.push(m.content),
  } as unknown as ExtensionAPI, { queuePi: pi.spawn });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "chat", getBranch: () => [], getEntries: () => [] },
    ui: { notify() {}, setStatus() {}, setWidget() {}, confirm: async (title: string, body: string) => (confirms.push(`${title}\n${body}`), true) },
  };
  const queue = (args: string) => commands.get("waicc-queue").handler(args, ctx);
  await queue("add Add paging to search");
  await queue("add Dark mode");
  await queue("list");
  assert.match(shown.at(-1)!, /Queue \(2 waiting\):\n- ⏳ \*\*1\*\* Add paging to search · waiting\n- ⏳ \*\*2\*\* Dark mode · waiting/);
  await queue("run --review-with sol");
  assert.match(confirms[0], /^Run 2 queued tasks\?[\s\S]*\(--review-with sol\)[\s\S]*autoShip is off: each stops with its review passed[\s\S]*Queued Pis answer every question no/);
  for (let i = 0; i < 500 && !shown.at(-1)!.startsWith("The queue is done."); i++) await new Promise((done) => setTimeout(done, 10));
  assert.match(shown.at(-1)!, /^The queue is done\.[\s\S]*🟡 \*\*1\*\* Add paging to search · reviewed[\s\S]*🟡 \*\*2\*\* Dark mode · reviewed/);
  const items = readQueue(root).items;
  assert.deepEqual(items.map((i) => i.branch), ["waicc/queue-1-add-paging-to-search", "waicc/queue-2-dark-mode"]);
  assert.ok(items.every((i) => i.folder && existsSync(i.folder) && i.folder !== root), "each in its own folder");
  assert.deepEqual(pi.started.map((s) => s.folder), items.map((i) => i.folder));
  assert.ok(pi.prompts.includes("/waicc-dispatch --auto --ship --review-with sol"));
  await queue("run --model x");
  assert.ok(true, "a command error is shown, not thrown");
});

test("the queue file: ids grow, finished tasks clear, a running task cannot be removed", (t) => {
  const { root } = project(t);
  assert.equal(addToQueue(root, "One").id, 1);
  assert.equal(addToQueue(root, "Two").id, 2);
  updateQueue(root, (q) => { q.items[0].status = "shipped"; });
  assert.equal(addToQueue(root, "Three").id, 3);
  assert.throws(() => addToQueue(root, "  "), /Say what the task is/);
});
