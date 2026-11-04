import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { activityLogLimit, activityLogName, readActivity, recordActivity, startActivity, summarizeActivity, type ActivityEntry } from "../src/activity-log.ts";
import { readErrors } from "../src/error-log.ts";
import { initialize, runtimePath } from "../src/files.ts";

function folder(t: TestContext, waiccProject = true) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  if (waiccProject) initialize(root);
  return root;
}
function extension() {
  const commands = new Map<string, any>(), tools = new Map<string, any>(), handlers = new Map<string, any>();
  waicc({
    registerCommand: (name: string, c: any) => commands.set(name, c), registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: any) => handlers.set(event, handler), appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  return { commands, tools, handlers };
}
const context = (root: string, chat = "flow-chat", trusted = () => true) => ({
  cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: trusted, model: { id: "test-model" },
  sessionManager: { getSessionId: () => chat, getBranch: () => [], getEntries: () => [] },
  ui: { notify() {}, setWidget() {}, setStatus() {} },
}) as unknown as ExtensionCommandContext;

test("steps are kept in the project's WAICC folder, never create one, keep only short values, and stay small", (t) => {
  const plain = folder(t, false);
  recordActivity(plain, { flow: "f", step: "/waicc-status", phase: "end", outcome: "ok" });
  assert.equal(existsSync(join(plain, runtimePath)), false, "a folder that does not use WAICC gets nothing");

  const root = folder(t);
  const end = startActivity(root, "f1", "dispatch review", { chat: "c", detail: { via: "codex", nested: { no: 1 } as never, long: "x".repeat(500) } });
  end("reply", { detail: { inputTokens: 1200 } });
  end("error");
  const [start, finish, ...rest] = readActivity(root);
  assert.equal(rest.length, 0, "an end is recorded once");
  assert.deepEqual([start.flow, start.step, start.phase, start.chat], ["f1", "dispatch review", "start", "c"]);
  assert.deepEqual(start.detail, { via: "codex", long: "x".repeat(120) }, "an object is dropped, a long string cut");
  assert.equal(finish.phase, "end");
  assert.equal(finish.outcome, "reply");
  assert.equal(typeof finish.ms, "number");
  assert.deepEqual(finish.detail, { via: "codex", long: "x".repeat(120), inputTokens: 1200 });
  assert.match(finish.version!, /^\d+\.\d+\.\d+/);

  for (let i = 0; i < 4_000; i++) recordActivity(root, { flow: `f${i}`, step: "waicc_prepare", phase: "end", ms: 5, outcome: "ok" });
  assert.ok(statSync(join(root, runtimePath, activityLogName)).size <= activityLogLimit, "the oldest half goes past the limit");
  assert.equal(readActivity(root).at(-1)!.flow, "f3999", "the newest stay");
  writeFileSync(join(root, runtimePath, activityLogName), "not json\n{\"at\":\"x\",\"flow\":\"f\",\"step\":\"s\",\"phase\":\"end\"}\n");
  assert.deepEqual(readActivity(root).map((e) => e.flow), ["f"], "a damaged line is skipped");
});

test("the summary shows each step's runs, failures, time and the starts that never ended", () => {
  const entry = (flow: string, step: string, phase: "start" | "end", ms?: number, outcome?: string): ActivityEntry =>
    ({ at: "2026-11-04T10:00:00.000Z", flow, step, phase, ms, outcome });
  const summary = summarizeActivity([
    entry("a", "/waicc-dispatch", "start"), entry("a", "dispatch review", "start"),
    entry("a", "/waicc-dispatch", "end", 200, "ok"),
    entry("a", "dispatch review", "end", 60_000, "reply"),
    entry("b", "dispatch review", "start"), entry("b", "dispatch review", "end", 30_000, "timeout"),
    entry("c", "dispatch review", "start"),
    entry("d", "waicc_prepare", "end", 10, "error"),
  ]);
  assert.deepEqual(summary.map((s) => s.step), ["dispatch review", "/waicc-dispatch", "waicc_prepare"], "where the time goes first");
  assert.deepEqual(summary[0], { step: "dispatch review", runs: 2, failed: 1, outcomes: { reply: 1, timeout: 1 }, averageMs: 45_000, maxMs: 60_000, unfinished: 1 });
  assert.deepEqual(summary[2], { step: "waicc_prepare", runs: 1, failed: 1, outcomes: { error: 1 }, averageMs: 10, maxMs: 10, unfinished: 0 });
});

test("a Pi command's steps and its error share one flow; the options are kept, never the text typed", async (t) => {
  const root = folder(t);
  const { commands } = extension();
  await commands.get("waicc-reopen").handler("Needed after all, secret words --force", context(root));
  const steps = readActivity(root);
  assert.deepEqual(steps.map((e) => [e.step, e.phase, e.outcome]), [["/waicc-reopen", "start", undefined], ["/waicc-reopen", "end", "error"]]);
  assert.equal(steps[0].flow, steps[1].flow);
  assert.deepEqual(steps[1].detail, { flags: "--force" });
  assert.ok(!readFileSync(join(root, runtimePath, activityLogName), "utf8").includes("secret"));
  const [error] = readErrors(root);
  assert.equal(error.flow, steps[0].flow, "the error leads back to its steps");

  await commands.get("waicc-list").handler("", context(root));
  const list = readActivity(root).slice(2);
  assert.deepEqual(list.map((e) => [e.step, e.outcome]), [["/waicc-list", undefined], ["/waicc-list", "ok"]]);
  assert.notEqual(list[0].flow, steps[0].flow, "each command its own flow");

  const untrusted = folder(t);
  await commands.get("waicc-list").handler("", context(untrusted, "x", () => false));
  assert.equal(readActivity(untrusted).length, 0, "nothing is written into a project you have not trusted");
});

test("a WAICC tool call is one line when it ends, with the flow its error has", async (t) => {
  const root = folder(t);
  const { tools } = extension();
  await assert.rejects(tools.get("waicc_suggest_command").execute("call", { commands: [{ command: "/reload", why: "x" }] }, undefined, undefined, context(root)));
  const [line, ...rest] = readActivity(root);
  assert.equal(rest.length, 0);
  assert.deepEqual([line.step, line.phase, line.outcome, line.chat], ["waicc_suggest_command", "end", "error", "flow-chat"]);
  assert.equal(readErrors(root)[0].flow, line.flow);
});

test("the main agent's turn is a step, with its model and how many steps it took", async (t) => {
  const root = folder(t);
  const { handlers } = extension();
  const ctx = context(root);
  await handlers.get("agent_start")({}, ctx);
  await handlers.get("agent_start")({}, ctx);
  await handlers.get("agent_end")({}, ctx);
  assert.deepEqual(readActivity(root).map((e) => [e.step, e.phase, e.outcome ?? null, e.detail?.model ?? null]), [
    ["main turn", "start", null, "test-model"], ["main turn", "end", "replaced", "test-model"],
    ["main turn", "start", null, "test-model"], ["main turn", "end", "ok", "test-model"],
  ]);
  assert.equal(readActivity(root).at(-1)!.detail!.steps, 0);
});

test("a CLI command is one line; waicc activity lists them, one flow with its errors, or each step's totals", (t) => {
  const root = folder(t);
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "--root", root, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(cli("continue", "00000000-0000-4000-8000-000000000000").status, 1);
  assert.equal(cli("list").status, 0);
  assert.equal(cli("my private words").status, 2);
  const all = JSON.parse(cli("activity").stdout);
  assert.deepEqual(all.entries.map((e: ActivityEntry) => [e.step, e.outcome, e.sessionId ?? null]), [
    ["waicc continue", "error", "00000000-0000-4000-8000-000000000000"], ["waicc list", "ok", null],
  ], "reading the log is not itself logged, nor a word that is no command");
  const one = JSON.parse(cli("activity", "--flow", all.entries[0].flow).stdout);
  assert.equal(one.count, 1);
  assert.deepEqual(one.errors.map((e: { source: string }) => e.source), ["waicc continue"]);
  const summary = JSON.parse(cli("activity", "--summary").stdout);
  assert.deepEqual(summary.steps.map((s: { step: string; runs: number; failed: number }) => [s.step, s.runs, s.failed]).sort(), [["waicc continue", 1, 1], ["waicc list", 1, 0]]);
  assert.equal(JSON.parse(cli("activity", "--since", "1m").stdout).count, 2);
  assert.match(cli("activity", "--bogus").stderr, /^Usage: waicc activity/);
});
