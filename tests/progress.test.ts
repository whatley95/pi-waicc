import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { prepareDispatch, runAgent, runDispatch, type AgentRunner } from "../src/dispatch.ts";
import { elapsed, progressParser } from "../src/progress.ts";
import { createSession, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const cwd = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";
const inProject = (file: string) => join(cwd, file);
const texts = (via: "claude" | "codex" | "pi", lines: unknown[]) => {
  const parse = progressParser(via, cwd);
  return lines.flatMap((line) => parse(typeof line === "string" ? line : JSON.stringify(line))).map((event) => `${event.kind}: ${event.text}`);
};

// Shapes captured from Claude Code 2.1 (--output-format stream-json --verbose).
test("Claude stream events become readable steps, notes and rejected drafts", () => {
  assert.deepEqual(texts("claude", [
    { type: "system", subtype: "init", cwd },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: inProject("src/search.ts") } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Grep", input: { pattern: "accountId", path: inProject("src") } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "mcp__waicc__waicc_validate_reply", input: { reply: {} } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", is_error: true, content: [{ type: "text", text: "proposedContract: Task contains unsupported fields: \"dependencies\"" }] }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Fixing the task fields,\nthen validating again." }] } },
    { type: "rate_limit_event" },
    "not json at all",
  ]), [
    "step: Reading src/search.ts",
    'step: Searching for "accountId" in src',
    "waicc: Validating the draft reply",
    'rejected: Draft rejected: proposedContract: Task contains unsupported fields: "dependencies"',
    "note: Fixing the task fields, then validating again.",
  ]);
});

// Shapes captured from Codex CLI 0.163 (exec --json).
test("Codex stream events: commands unwrapped from the shell, MCP calls and their errors", () => {
  assert.deepEqual(texts("codex", [
    { type: "thread.started" },
    { type: "item.started", item: { type: "command_execution", command: "\"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe\" -Command \"rg -n 'export function' index.js\"" } },
    { type: "item.started", item: { type: "mcp_tool_call", server: "waicc", tool: "waicc_receive", arguments: {} } },
    { type: "item.started", item: { type: "mcp_tool_call", server: "waicc", tool: "waicc_run_check", arguments: { check: 0 } } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "waicc", tool: "waicc_submit_reply", result: { isError: true, content: [{ type: "text", text: "Reply must cover every requirement" }] } } },
    { type: "item.started", item: { type: "file_change", changes: [{ path: inProject("index.js") }] } },
    { type: "item.completed", item: { type: "agent_message", text: "Submitted." } },
  ]), [
    "step: Running rg -n 'export function' index.js",
    "waicc: Received the assignment",
    "waicc: Running approved check 0",
    "rejected: Draft rejected: Reply must cover every requirement",
    "step: Editing index.js",
    "note: Submitted.",
  ]);
});

// Shapes captured from Pi 1.2 (--mode json).
test("Pi stream events: tool starts, failed WAICC calls and assistant text", () => {
  assert.deepEqual(texts("pi", [
    { type: "agent_start" },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "index.js" } },
    { type: "tool_execution_start", toolCallId: "c2", toolName: "waicc_reply", args: { reply: {}, validateOnly: true } },
    { type: "tool_execution_end", toolCallId: "c2", toolName: "waicc_reply", isError: true, result: { content: [{ type: "text", text: "Planned verification must be nonempty text" }] } },
    { type: "tool_execution_start", toolCallId: "c3", toolName: "waicc_check", args: { program: "npm", args: ["test"] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "All checks passed." }] } },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "ignored" }] } },
  ]), [
    "step: Reading index.js",
    "waicc: Validating the draft reply",
    "rejected: Draft rejected: Planned verification must be nonempty text",
    "waicc: Running approved check: npm test",
    "note: All checks passed.",
  ]);
  assert.equal(elapsed(4_200), "4s");
  assert.equal(elapsed(65_000), "1m 05s");
});

test("the runner delivers complete stdout lines even when output arrives in pieces", async (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, "chunks.mjs");
  writeFileSync(script, `process.stdout.write('{"a":'); setTimeout(() => { process.stdout.write('1}\\n{"b":2}\\n{"c"'); setTimeout(() => process.stdout.write(':3}'), 50); }, 50);`);
  const lines: string[] = [];
  const result = await runAgent(process.execPath, [script], { cwd: dir, timeout: 30_000, onLine: (line) => lines.push(line) });
  assert.equal(result.code, 0);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

const contract: Contract = {
  title: "Search",
  requirements: [{ id: "REQ-001", text: "Add search", sourceQuote: "Add search" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: ["wai-node"],
  tasks: [{
    id: "SEARCH", title: "Add search", requirementIds: ["REQ-001"], dependsOn: [], allowedPaths: ["source.txt"],
    acceptance: [{ id: "AC-001", text: "Return expected results", requirementIds: ["REQ-001"], verification: "Exercise search cases" }],
  }],
};
function planning(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "source");
  const s = createSession(root, "Add search");
  prepare(root, s.id, contract, "planning", "Inspect search", 0);
  return { root, id: s.id };
}
/** A fake Claude run that streams two steps and a message. */
const streaming = (root: string, gate?: Promise<void>): AgentRunner => async (_program, _args, options) => {
  options.onLine?.(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: join(root, "source.txt") } }] } }));
  await gate;
  options.onLine?.(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The plan needs one task." }] } }));
  return { stdout: "", stderr: "", code: 0, killed: false };
};

test("the dispatch log keeps every step and the agent's last message", async (t) => {
  const { root, id } = planning(t);
  const seen: string[] = [];
  const outcome = await runDispatch(prepareDispatch(root, id, { via: "claude" }), streaming(root), undefined, (event) => seen.push(event.text));
  assert.deepEqual(seen, ["Reading source.txt", "The plan needs one task."]);
  assert.equal(outcome.lastMessage, "The plan needs one task.");
  assert.equal(outcome.steps, 2);
  const log = JSON.parse(readFileSync(outcome.log!, "utf8"));
  assert.deepEqual(log.progress.map((event: { text: string }) => event.text), seen);
});

test("Pi shows a live dispatch panel and status, lists steps on --progress, and clears both when done", async (t) => {
  const { root, id } = planning(t);
  const commands = new Map<string, any>(), shown: any[] = [], entries: any[] = [];
  const widgets: (string[] | undefined)[] = [], statuses: (string | undefined)[] = [];
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool() {}, on() {},
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
    sendMessage: (m: any) => shown.push(m), sendUserMessage() {},
  } as unknown as ExtensionAPI, { runAgent: streaming(root, gate) });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "progress-chat", getBranch: () => entries },
    ui: {
      notify() {},
      setWidget: (key: string, lines: string[] | undefined) => { assert.equal(key, "waicc-dispatch"); widgets.push(lines); },
      setStatus: (key: string, text: string | undefined) => { assert.equal(key, "waicc-dispatch"); statuses.push(text); },
    },
  } as unknown as ExtensionCommandContext;
  await commands.get("waicc-use").handler(id, ctx);
  await commands.get("waicc-dispatch").handler("--via claude --model sonnet --effort low", ctx);
  await new Promise((done) => setTimeout(done, 50));
  const panel = widgets.at(-1)!;
  assert.match(panel[0], /^WAICC · claude sonnet \(low\) planning · \d+s · 1 steps/);
  assert.match(panel[1], /› Reading source\.txt$/);
  assert.match(statuses.at(-1)!, /^claude planning · \d+s$/);

  await commands.get("waicc-dispatch").handler("--progress", ctx);
  assert.match(shown.at(-1).content, /Reading source\.txt/);

  release();
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(widgets.at(-1), undefined, "panel cleared");
  assert.equal(statuses.at(-1), undefined, "status cleared");
  const result = JSON.parse(shown.find((m) => m.customType === "waicc-dispatch").content);
  assert.equal(result.lastMessage, "The plan needs one task.");
  await assert.doesNotReject(commands.get("waicc-dispatch").handler("--progress", ctx));
});

test("handoff files are named instead of shown by their deep WAICC paths", () => {
  const handoff = (file: string) => inProject(join(".pi", "pi-waicc", "sessions", "abc-1", ...file.split("/")));
  assert.deepEqual(texts("claude", [
    { type: "assistant", message: { content: [
      { type: "tool_use", id: "a", name: "Read", input: { file_path: handoff("rounds/r-9/HANDOFF.md") } },
      { type: "tool_use", id: "b", name: "Read", input: { file_path: handoff("contracts/v001/contract.json") } },
      { type: "tool_use", id: "c", name: "ToolSearch", input: { query: "waicc" } },
    ] } },
  ]), [
    "step: Reading the handoff's HANDOFF.md",
    "step: Reading the handoff's contracts/v001/contract.json",
    "step: Loading its tools",
  ]);
});
