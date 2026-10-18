import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { loadSession } from "../src/files.ts";
import { dispatch, dispatchOptions, prepareDispatch, runAgent, runDispatch, windowsCommand, type AgentRunner } from "../src/dispatch.ts";
import { mcpServer } from "../src/mcp.ts";
import { receiveHandoff, submitRecipientReply, validateRecipientReply } from "../src/recipient.ts";
import { assess, createSession, delegateWork, ingest, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

function contract(): Contract {
  return {
    title: "Search",
    requirements: [{ id: "REQ-001", text: "Add search", sourceQuote: "Add search" }],
    exclusions: [], assumptions: [], questions: [], risks: [], skills: ["wai-node"],
    tasks: [{
      id: "SEARCH", title: "Add search", requirementIds: ["REQ-001"], dependsOn: [], allowedPaths: ["source.txt"],
      acceptance: [{ id: "AC-001", text: "Return expected results", requirementIds: ["REQ-001"], verification: "Exercise search cases" }],
    }],
  };
}
const body = () => ({
  outcome: "ready",
  summary: "Inspected search scope; delivery unverified.",
  coverage: [{ requirementId: "REQ-001", status: "addressed", evidence: "REQ-001 and AC-001 examined against source.txt" }],
  findings: [], questions: [],
  checks: [{ description: "Run search tests", outcome: "not_run", evidence: "Read-only recipient" }],
});
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "waicc-test-"));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "source");
  const s = createSession(root, "Add search");
  prepare(root, s.id, contract(), "planning", "Inspect search", 0);
  return { root, id: s.id, requestId: loadSession(root, s.id).rounds[0].id };
}
/** Stands in for a headless agent that uses the WAICC MCP tools correctly. */
const cooperative = (id: string): AgentRunner => async (_program, _args, options) => {
  submitRecipientReply(options.cwd, receiveHandoff(options.cwd, id).pin, body());
  return { stdout: "done", stderr: "", code: 0, killed: false };
};
const silent: AgentRunner = async () => ({ stdout: "", stderr: "", code: 0, killed: false });
/** A planning handoff answered and accepted, then one whole-plan implementation handoff waiting. */
function implementationWaiting(t: TestContext) {
  const { root, id } = fixture(t);
  submitRecipientReply(root, receiveHandoff(root, id).pin, { ...body(), outcome: "planned" });
  const received = ingest(root, id);
  assess(root, id, { requestId: received.rounds.at(-1)!.id, decision: "planned", rationale: "Source checked", dispositions: [] });
  delegateWork(root, id, "implementation", "Implement everything");
  return { root, id, requestId: loadSession(root, id).rounds.at(-1)!.id };
}

test("MCP server speaks JSON-RPC over stdio, pins one request and validates before the single write", async (t) => {
  const { root, id, requestId } = fixture(t);
  const child = spawn(process.execPath, [resolve("src/cli.ts"), "--root", root, "mcp", "--session", id, "--request", requestId], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => child.kill());
  const pending = new Map<number, (value: any) => void>();
  let buffer = "", next = 0;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) {
      const message = JSON.parse(buffer.slice(0, i));
      pending.get(message.id)?.(message);
    }
  });
  const rpc = (method: string, params: object = {}) => new Promise<any>((done) => {
    const messageId = ++next;
    pending.set(messageId, done);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: messageId, method, params })}\n`);
  });
  const call = async (name: string, args: object = {}) => (await rpc("tools/call", { name, arguments: args })).result;

  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "waicc");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  assert.deepEqual((await rpc("tools/list")).result.tools.map((tool: { name: string }) => tool.name),
    ["waicc_receive", "waicc_assignment", "waicc_validate_reply", "waicc_submit_reply"]);
  assert.equal((await rpc("bogus")).error.code, -32601);

  assert.match((await call("waicc_submit_reply", { reply: body() })).content[0].text, /waicc_receive/);
  const wrong = await call("waicc_receive", { sessionId: id, requestId: "other-request" });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0].text, /different request/);
  const received = await call("waicc_receive", { sessionId: id, requestId });
  assert.equal(received.isError, undefined);
  assert.equal(JSON.parse(received.content[0].text).pin.requestId, requestId);

  const incomplete = await call("waicc_validate_reply", { reply: { ...body(), coverage: [] } });
  assert.equal(incomplete.isError, true);
  const replyPath = join(root, ".pi", "pi-waicc", "sessions", id, "rounds", requestId, "reply.json");
  assert.equal(existsSync(replyPath), false, "a dry run never writes");
  const valid = JSON.parse((await call("waicc_validate_reply", { reply: body() })).content[0].text);
  assert.equal(valid.valid, true);
  assert.equal(existsSync(replyPath), false);
  assert.equal(JSON.parse((await call("waicc_submit_reply", { reply: body() })).content[0].text).submitted, true);
  assert.equal((await call("waicc_submit_reply", { reply: body() })).isError, true, "first reply wins");
  assert.equal(ingest(root, id).status, "AWAITING_ASSESSMENT");
});

test("MCP receive refuses implementation work that only Pi can confine to task paths", (t) => {
  const { root, id, requestId } = implementationWaiting(t);
  const handle = mcpServer(root);
  const response = handle({ id: 1, method: "tools/call", params: { name: "waicc_receive", arguments: { sessionId: id, requestId } } }) as any;
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /implementation assignment/);
  assert.equal(handle({ method: "notifications/initialized" }), undefined, "notifications get no response");
  assert.equal((handle({ id: 2, method: "tools/call", params: { name: "nope" } }) as any).error.code, -32602);
});

test("dispatch builds read-only, request-pinned invocations for every supported agent", async (t) => {
  const { root, id, requestId } = fixture(t);
  for (const via of ["claude", "codex", "pi", "agy"] as const) {
    const plan = prepareDispatch(root, id, { via, model: "some-model" });
    const line = plan.args.join(" ");
    assert.equal(plan.program, via);
    assert.ok(line.includes("some-model"));
    if (via === "claude") {
      assert.ok(line.includes("--strict-mcp-config") && line.includes("--disallowedTools Edit,Write,NotebookEdit,Bash"));
      const config = JSON.parse(readFileSync(plan.args[plan.args.indexOf("--mcp-config") + 1], "utf8"));
      assert.deepEqual(config.mcpServers.waicc.args.slice(-5), ["mcp", "--session", id, "--request", requestId]);
    }
    if (via === "codex") {
      assert.ok(line.includes("--sandbox read-only"));
      assert.ok(plan.args.some((arg) => arg.startsWith("mcp_servers.waicc.args=") && arg.includes(requestId)));
      assert.ok(plan.args.includes('mcp_servers.waicc.default_tools_approval_mode="approve"'));
      assert.ok(plan.args.some((arg) => arg.startsWith("mcp_servers.waicc.enabled_tools=") && arg.includes("waicc_submit_reply")));
    }
    if (via === "pi") {
      assert.deepEqual(plan.env, { WAICC_DISPATCH_PIN: `${id}:${requestId}` });
      assert.match(plan.args.at(-1)!, /already pinned.*validateOnly/);
    }
    if (via !== "pi") assert.ok(!/[\r\n]/.test(plan.prompt) && plan.prompt.includes(requestId));
    // Each prepared plan holds the one-dispatch slot until its result is recorded.
    assert.throws(() => prepareDispatch(root, id, { via: "claude" }), /still working/);
    await runDispatch(plan, silent);
    assert.ok(plan.scratch.every((path) => !existsSync(path)), "per-run MCP config is removed");
  }
});

test("dispatch records an audit log, never assesses, and refuses answered requests", async (t) => {
  const { root, id, requestId } = fixture(t);
  assert.throws(() => dispatchOptions("--via gemini"), /--via must be one of/);
  assert.throws(() => dispatchOptions("--model x"), /Usage/);
  assert.throws(() => dispatchOptions("--via claude --timeout 500"), /1–120/);
  assert.deepEqual(dispatchOptions("--via codex -m gpt-5.5 --timeout 10"), { via: "codex", model: "gpt-5.5", timeoutMinutes: 10 });

  const failed = await dispatch(root, id, { via: "codex" }, async () => ({ stdout: "", stderr: "not signed in", code: 1, killed: false }));
  assert.equal(failed.replySubmitted, false);
  assert.match(failed.nextAction, /still waiting/);
  const log = JSON.parse(readFileSync(failed.log!, "utf8"));
  assert.equal(log.stderr, "not signed in");
  assert.equal(log.requestId, requestId);

  const outcome = await dispatch(root, id, { via: "claude", model: "opus" }, cooperative(id));
  assert.equal(outcome.replySubmitted, true);
  assert.equal(loadSession(root, id).status, "WAITING_FOR_REPLY", "dispatch does not ingest or assess");
  assert.throws(() => prepareDispatch(root, id, { via: "claude" }), /reply already exists/);
  assert.equal(ingest(root, id).status, "AWAITING_ASSESSMENT");
});

test("implementation dispatch needs --implement and Pi, whose recipient mode confines edits to task paths", async (t) => {
  const { root, id, requestId } = implementationWaiting(t);
  assert.throws(() => prepareDispatch(root, id, { via: "pi" }), /Add --implement/);
  for (const via of ["claude", "codex", "agy"] as const)
    assert.throws(() => prepareDispatch(root, id, { via, implement: true }), /Only --via pi/);
  assert.deepEqual(dispatchOptions("--via pi --implement --model deepseek/x"), { via: "pi", implement: true, model: "deepseek/x" });
  const plan = prepareDispatch(root, id, { via: "pi", implement: true });
  assert.equal(plan.env.WAICC_DISPATCH_PIN, `${id}:${requestId}:implement`);
  assert.match(plan.args.at(-1)!, /editing only the task's allowed paths/);
  await runDispatch(plan, silent);

  const coder = await bootDispatchedPi(root, `${id}:${requestId}:implement`);
  assert.ok(coder.active().includes("edit") && coder.active().includes("write"));
  assert.ok(!coder.active().includes("bash"), "no shell even when coding");
  assert.equal(await coder.toolCall("edit", { path: "source.txt" }), undefined, "allowed task path");
  assert.equal((await coder.toolCall("write", { path: "elsewhere.txt" }))?.block, true, "outside task paths");
  assert.equal((await coder.toolCall("bash", { command: "echo" }))?.block, true);
  // Without the opt-in, the same implementation request is refused outright.
  assert.deepEqual((await bootDispatchedPi(root, `${id}:${requestId}`)).active(), []);
});

test("--implement on a read-only handoff is refused", (t) => {
  const { root, id } = fixture(t);
  assert.throws(() => prepareDispatch(root, id, { via: "pi", implement: true }), /only to an implementation handoff/);
});

test("Windows command shims receive metacharacter-heavy arguments intact", { skip: process.platform !== "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "waicc-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "echo.mjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  writeFileSync(join(dir, "echoargs.cmd"), `@"${process.execPath}" "%~dp0echo.mjs" %*\r\n`);
  const args = ["plain", "with space", `quote " inside`, "trailing\\", "a&b|c<d>e^f%PATH%!x!", `mcp_servers.waicc.args=["C:\\\\x y","--root"]`, "(paren),semi;"];
  const env = { ...process.env, PATH: `${dir};${process.env.PATH}` };
  assert.match(windowsCommand("echoargs", args, env).file, /cmd\.exe$/i);
  process.env.PATH = env.PATH;
  t.after(() => { process.env.PATH = env.PATH!.slice(dir.length + 1); });
  const result = await runAgent("echoargs", args, { cwd: dir, timeout: 30_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.throws(() => windowsCommand("echoargs", ["two\nlines"], env), /line breaks/);
});

test("/waicc-dispatch runs in the background, reports the result and is coordinator-only", async (t) => {
  const { root, id } = fixture(t);
  const commands = new Map<string, any>(), shown: any[] = [], notices: string[] = [], entries: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool() {}, on() {},
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
    sendMessage: (m: any) => shown.push(m), sendUserMessage() {},
  } as unknown as ExtensionAPI, {
    runAgent: async (program, args, options) => { await gate; return cooperative(id)(program, args, options); },
  });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "dispatch-chat", getBranch: () => entries },
    ui: { notify: (m: string) => notices.push(m) },
  } as unknown as ExtensionCommandContext;
  await commands.get("waicc-use").handler(id, ctx);
  await commands.get("waicc-dispatch").handler("--via claude --model opus", ctx);
  assert.equal(JSON.parse(shown.at(-1).content).dispatching, true);
  await commands.get("waicc-dispatch").handler("--via codex", ctx);
  assert.match(notices.at(-1)!, /already running/);
  release();
  await new Promise((done) => setTimeout(done, 200));
  const finished = shown.find((m) => m.customType === "waicc-dispatch");
  assert.equal(JSON.parse(finished.content).replySubmitted, true);
  assert.match(notices.at(-1)!, /claude submitted a reply/);
});

/** Boots the extension the way dispatch starts a headless Pi: with a pin in the environment. */
async function bootDispatchedPi(root: string, pin: string) {
  const hooks = new Map<string, any>(), tools = new Map<string, any>(), entries: any[] = [];
  let active = ["read", "edit", "write", "bash", "grep", "waicc_status", "waicc_reply"];
  waicc({
    registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool), on: (n: string, h: any) => hooks.set(n, h),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => active.map((name) => ({ name })), getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root, mode: "print", hasUI: false, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => `dispatched-${pin}`, getBranch: () => entries },
    ui: { notify() {} },
  } as unknown as ExtensionCommandContext;
  process.env.WAICC_DISPATCH_PIN = pin;
  try { await hooks.get("session_start")({}, ctx); } finally { delete process.env.WAICC_DISPATCH_PIN; }
  const context = await hooks.get("before_agent_start")({ prompt: "go", messageType: "user" }, ctx);
  return {
    active: () => active, context,
    reply: (params: object) => tools.get("waicc_reply").execute("x", params, undefined, undefined, ctx),
    toolCall: (toolName: string, input: object) => hooks.get("tool_call")({ toolName, input }, ctx),
  };
}

test("a dispatched headless Pi pins its request read-only at startup and refuses any other request", async (t) => {
  const { root, id, requestId } = fixture(t);
  const boot = (pin: string) => bootDispatchedPi(root, pin);
  const refused = await boot(`${id}:another-request`);
  assert.deepEqual(refused.active(), []);
  assert.match(refused.context.message.content, /STOP: .*not the dispatched one/);

  const pinned = await boot(`${id}:${requestId}`);
  assert.ok(!pinned.active().some((name: string) => ["edit", "write", "bash"].includes(name)), "no write or shell tools");
  assert.ok(pinned.active().includes("waicc_reply"));
  assert.match(pinned.context.message.content, new RegExp(requestId));
  const dry = JSON.parse((await pinned.reply({ reply: body(), validateOnly: true })).content[0].text);
  assert.equal(dry.valid, true);
  assert.equal(existsSync(join(root, ".pi", "pi-waicc", "sessions", id, "rounds", requestId, "reply.json")), false);
  assert.equal(JSON.parse((await pinned.reply({ reply: body() })).content[0].text).submitted, true);
});

test("a malformed proposedContract names its location and shows a valid example that really validates", (t) => {
  const { root, id } = fixture(t);
  const assignment = receiveHandoff(root, id);
  const example = assignment.proposedContractExample!;
  assert.ok(example, "planning assignments carry the example");
  // The example passes the real validator once its requirements are the contract's own.
  const proposed = { ...structuredClone(example), requirements: contract().requirements };
  proposed.tasks[0].allowedPaths = ["source.txt"];
  assert.equal(validateRecipientReply(root, assignment.pin, { ...body(), outcome: "planned", proposedContract: proposed }).valid, true);
  const guessed = { ...proposed, tasks: [{ id: "T1", title: "x", dependencies: [], acceptanceCriteria: ["works"] }] };
  assert.throws(
    () => validateRecipientReply(root, assignment.pin, { ...body(), outcome: "planned", proposedContract: guessed }),
    (error: Error) => /^proposedContract: .*unsupported fields/.test(error.message) && error.message.includes('"acceptance":[{"id":"AC-001"'),
  );
});
