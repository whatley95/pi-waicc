import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { dispatchOptions, prepareDispatch, runDispatch } from "../src/dispatch.ts";
import { loadSession } from "../src/files.ts";
import { mcpServer } from "../src/mcp.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { assess, createSession, delegateWork, ingest, prepare } from "../src/workflow.ts";
import type { CheckCommand } from "../src/checks.ts";
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
  outcome, summary: "Inspected search; delivery unverified.",
  coverage: [{ requirementId: "REQ-001", status: "addressed", evidence: "source.txt implements AC-001" }],
  findings: [], questions: [],
  checks: [{ description: "Run search tests", outcome: "not_run", evidence: "Not run yet" }],
});
/** A check that prints where it ran, so tests can see the working directory. */
const whereAmI: CheckCommand = { program: process.execPath, args: ["-e", "console.log(process.cwd())"], timeoutMs: 60_000 };
const silent = async () => ({ stdout: "", stderr: "", code: 0, killed: false });

/** An accepted plan with one handoff waiting: testing by default, or still planning. */
function waiting(t: TestContext, mode: "testing" | "planning" = "testing") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "source");
  const s = createSession(root, "Add search");
  prepare(root, s.id, contract, "planning", "Inspect search", 0);
  if (mode === "testing") {
    submitRecipientReply(root, receiveHandoff(root, s.id).pin, body("planned"));
    const received = ingest(root, s.id);
    assess(root, s.id, { requestId: received.rounds.at(-1)!.id, decision: "planned", rationale: "Source checked", dispositions: [] });
    delegateWork(root, s.id, "testing", "Test everything");
  }
  return { root, id: s.id, requestId: loadSession(root, s.id).rounds.at(-1)!.id };
}

test("testing dispatch needs pre-approved checks, which reach every agent's WAICC tools and nothing else", async (t) => {
  const { root, id } = waiting(t);
  assert.throws(() => prepareDispatch(root, id, { via: "claude" }), /needs at least one pre-approved check/);
  assert.throws(() => prepareDispatch(root, id, { via: "agy", checks: [whereAmI] }), /Antigravity .* cannot receive pre-approved checks/);
  const planning = waiting(t, "planning");
  assert.throws(() => prepareDispatch(planning.root, planning.id, { via: "claude", checks: [whereAmI] }), /only to testing and implementation/);
  assert.throws(() => dispatchOptions("--via codex --check-timeout 99"), /1–30 minutes/);
  assert.throws(() => dispatchOptions(`--via codex ${Array(11).fill('--check "npm test"').join(" ")}`), /At most 10/);

  for (const via of ["claude", "codex", "pi"] as const) {
    const plan = prepareDispatch(root, id, { via, checks: [whereAmI] });
    if (via === "pi") assert.deepEqual(JSON.parse(plan.env.WAICC_DISPATCH_CHECKS), [whereAmI]);
    else {
      const server: string[] = via === "claude"
        ? JSON.parse(readFileSync(plan.args[plan.args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.waicc.args
        : JSON.parse(plan.args.find((arg) => arg.startsWith("mcp_servers.waicc.args="))!.slice("mcp_servers.waicc.args=".length));
      const file = server[server.indexOf("--checks") + 1];
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [whereAmI]);
      assert.ok(!server.includes("--implement"), "a tester never receives implementation");
      assert.match(plan.prompt, /waicc_run_check by number \(0: /);
      await runDispatch(plan, silent);
      assert.equal(existsSync(file), false, "the approved list is removed after the run");
      continue;
    }
    await runDispatch(plan, silent);
  }
});

test("waicc_run_check runs only the pre-approved checks and logs each one", async (t) => {
  const { root, id, requestId } = waiting(t);
  const call = async (handle: ReturnType<typeof mcpServer>, name: string, args: object) =>
    ((await handle({ id: 1, method: "tools/call", params: { name, arguments: args } })) as any).result;
  const none = mcpServer(root, { sessionId: id, requestId });
  await call(none, "waicc_receive", { sessionId: id, requestId });
  assert.match((await call(none, "waicc_run_check", { check: 0 })).content[0].text, /No checks were pre-approved/);

  const tester = mcpServer(root, { sessionId: id, requestId, checks: [whereAmI] });
  const received = (await call(tester, "waicc_receive", { sessionId: id, requestId })).content[0].text;
  assert.match(received, /Pre-approved checks, run with waicc_run_check by number:\n0: /);
  assert.match((await call(tester, "waicc_run_check", { check: 1 })).content[0].text, /from 0 to 0/);
  const ran = JSON.parse((await call(tester, "waicc_run_check", { check: 0 })).content[0].text);
  assert.equal(ran.outcome, "passed");
  assert.equal(realpathSync.native(ran.stdout.trim()), root, "runs at the project root");
  assert.ok(existsSync(join(root, ".pi", "pi-waicc", "sessions", id, ran.artifactPath)), "logged in the round");
});

test("a dispatched Pi tester runs pre-approved checks without a dialog, and no other command", async (t) => {
  const { root, id, requestId } = waiting(t);
  const hooks = new Map<string, any>(), tools = new Map<string, any>(), entries: any[] = [];
  let active = ["read", "bash", "waicc_status", "waicc_reply", "waicc_check"];
  waicc({
    registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool), on: (n: string, h: any) => hooks.set(n, h),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => active.map((name) => ({ name })), getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root, mode: "print", hasUI: false, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "dispatched-tester", getBranch: () => entries },
    ui: { notify() {}, confirm: async () => assert.fail("no dialog for a pre-approved check") },
  } as unknown as ExtensionCommandContext;
  process.env.WAICC_DISPATCH_PIN = `${id}:${requestId}`;
  process.env.WAICC_DISPATCH_CHECKS = JSON.stringify([whereAmI]);
  try {
    await hooks.get("session_start")({}, ctx);
  } finally {
    delete process.env.WAICC_DISPATCH_PIN;
    delete process.env.WAICC_DISPATCH_CHECKS;
  }
  assert.ok(active.includes("waicc_check") && !active.includes("bash"));
  const check = (params: object) => tools.get("waicc_check").execute("x", params, undefined, undefined, ctx);
  const ran = JSON.parse((await check({ program: whereAmI.program, args: whereAmI.args })).content[0].text);
  assert.equal(ran.outcome, "passed");
  await assert.rejects(check({ program: whereAmI.program, args: ["-e", "1"] }), /Only the pre-approved checks can run/);
  assert.equal((await hooks.get("tool_call")({ toolName: "bash", input: { command: "echo" } }, ctx))?.block, true);
});
