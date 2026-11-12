import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { mcpServer } from "../src/mcp.ts";
import { coordinatorSpecs } from "../src/mcp-coordinator.ts";
import { createSession, ingest } from "../src/workflow.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { loadSession } from "../src/files.ts";
import type { Contract } from "../src/types.ts";

function project(t: TestContext, user?: unknown) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const root = join(base, "project"), agentDir = join(base, "agent");
  mkdirSync(root);
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  if (user !== undefined) writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify(user));
  writeFileSync(join(root, "source.txt"), "source");
  return root;
}
const contract = (): Contract => ({
  title: "Search",
  requirements: [{ id: "REQ-001", text: "Add search", sourceQuote: "Add search" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{
    id: "SEARCH", title: "Add search", requirementIds: ["REQ-001"], dependsOn: [], allowedPaths: ["source.txt"],
    acceptance: [{ id: "AC-001", text: "Return expected results", requirementIds: ["REQ-001"], verification: "Exercise search cases" }],
  }],
});
function client(root: string, options: Parameters<typeof mcpServer>[1] = {}) {
  const handle = mcpServer(root, { coordinator: true, ...options });
  let id = 0;
  const rpc = async (method: string, params?: Record<string, unknown>) => (await handle({ jsonrpc: "2.0", id: ++id, method, params }) as { result: any }).result;
  const call = async (name: string, args: object = {}) => {
    const result = await rpc("tools/call", { name, arguments: args });
    return { text: result.content[0].text as string, isError: result.isError === true };
  };
  return { rpc, call };
}

test("the coordinator server offers the main agent's tools, and says the human runs WAICC's commands on the command line", async (t) => {
  const { rpc } = client(project(t));
  const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.match(init.instructions, /there are no \/waicc-\* slash commands here/);
  assert.match(init.instructions, /\/waicc-develop is "waicc develop <session-id>"/);
  assert.match(init.instructions, /! waicc develop/);
  assert.match(init.instructions, /contract OWNER\/coordinator/, "the main agent's own instructions, as Pi gives them");
  // Claude Code keeps 4,096 characters of them: with its mod, the rules are in the system prompt instead.
  const short = (await client(project(t), { rulesInPrompt: true }).rpc("initialize", { protocolVersion: "2025-06-18" })).instructions as string;
  assert.ok(short.length <= 4096, `${short.length} characters`);
  assert.match(short, /WAICC rules section/);
  assert.match(short, /\/waicc-develop is "waicc develop <session-id>"/);
  assert.doesNotMatch(short, /contract OWNER\/coordinator/);
  const { tools } = await rpc("tools/list");
  assert.deepEqual(tools.map((tool: { name: string }) => tool.name), coordinatorSpecs.map((spec) => spec.name));
  assert.ok(!tools.some((tool: { name: string }) => ["waicc_receive", "waicc_submit_reply", "waicc_start_planning"].includes(tool.name)),
    "no recipient tools, and no planning start without the human's own words");
});

test("a coordinator works on the session it names, then on that one; refusals are logged and from the second send it to the human", async (t) => {
  const root = project(t);
  const { call } = client(root);
  // No session yet: the human starts one.
  const none = await call("waicc_status");
  assert.equal(none.isError, true);
  assert.match(none.text, /No open WAICC session in this project\. The human starts one with: waicc start "<their request>"$/);
  // No advisor role: the second refusal in a row points at the human.
  assert.match((await call("waicc_status")).text, /This is your 2nd refused WAICC call in a row\. Do not guess again: if the error does not say exactly what to change, stop and ask the human\.$/);

  const s = createSession(root, "Add search");
  const prepared = await call("waicc_prepare", { sessionId: s.id, expectedVersion: 0, mode: "planning", focus: "Inspect search", contract: contract() });
  assert.equal(prepared.isError, false, prepared.text);
  assert.match(prepared.text, /"status": "WAITING_FOR_REPLY"/);
  assert.match(prepared.text, /Not shown to you/, "the agent never gets the handoff prompt");
  // The session it named is the one it works on now: no ID needed.
  const now = await call("waicc_status");
  assert.equal(now.isError, false);
  assert.match(now.text, new RegExp(`"sessionId": "${s.id}"`));

  // A recipient answers; the coordinator assesses through the same tools.
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "planned", summary: "Plan checked against source.txt.", findings: [], questions: [],
    coverage: [{ requirementId: "REQ-001", status: "addressed", evidence: "AC-001 covers REQ-001 in source.txt" }],
    checks: [{ description: "Search tests", outcome: "not_run", evidence: "Read-only planner" }],
  });
  const requestId = ingest(root, s.id).rounds.at(-1)!.id;
  const wrong = await call("waicc_assess", { sessionId: s.id, requestId: "nope", decision: "planned", rationale: "Source checked", dispositions: [] });
  assert.match(wrong.text, /No request nope in this session\. The reply waiting to be assessed is /);
  const assessed = await call("waicc_assess", { sessionId: s.id, requestId, decision: "planned", rationale: "Source checked", dispositions: [] });
  assert.equal(assessed.isError, false, assessed.text);
  assert.equal(loadSession(root, s.id).status, "PLAN_READY");

  // Logged as Pi logs its tools, under this server's own chat name (once the project has WAICC state).
  const errors = readFileSync(join(root, ".pi", "pi-waicc", "errors.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(errors.map((error) => error.source), ["waicc_assess"]);
  assert.match(errors[0].chat, /^mcp-[0-9a-f]{8}$/);
  assert.equal(errors[0].sessionId, s.id);
  assert.equal(errors[0].args.requestId, "string", "the arguments' shape, never their text");
  const steps = readFileSync(join(root, ".pi", "pi-waicc", "activity.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(steps.map((step) => `${step.step} ${step.outcome}`).slice(-3), ["waicc_status ok", "waicc_assess error", "waicc_assess ok"]);
});

test("the advisor answers within the human's per-session limit, and what the human must hear rides on the result", async (t) => {
  const root = project(t, { profiles: { sonnet: { via: "claude", model: "sonnet" } }, roles: { advisor: "sonnet" }, autoAdvisor: { maxPerChat: 1 } });
  const answers = ["Diagnosis: the index is stale."];
  const { call } = client(root, {
    runAgent: async () => ({ stdout: `${JSON.stringify({ type: "result", subtype: "success", result: answers.shift() ?? "" })}\n`, stderr: "", code: 0, killed: false }),
  });
  const first = await call("waicc_ask_advisor", { question: "Why is search empty?", tried: "Rebuilt it." });
  assert.equal(first.isError, false, first.text);
  assert.match(first.text, /^Advice from sonnet \(claude sonnet\), question 1 of 1 for this chat/);
  const second = await call("waicc_ask_advisor", { question: "Again?", tried: "Nothing new." });
  assert.match(second.text, /You have used all 1 advisor questions for this chat/);
});

test("waicc mcp --coordinator speaks MCP over stdio", async (t) => {
  const root = project(t);
  const child = spawn(process.execPath, [resolve("src/cli.ts"), "--root", root, "mcp", "--coordinator"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => child.kill());
  let out = "";
  const reply = new Promise<string>((done) => child.stdout.on("data", (chunk) => {
    out += chunk;
    if (out.includes("\n")) done(out);
  }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  const tools = JSON.parse((await reply).split("\n")[0]).result.tools;
  assert.equal(tools.length, coordinatorSpecs.length);
  child.stdin.end();
});
