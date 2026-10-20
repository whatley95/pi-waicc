import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { artifact, loadSession } from "../src/files.ts";
import type { AgentRunner } from "../src/dispatch.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { assess, createSession, issue, prepare } from "../src/workflow.ts";
import type { Contract, ContractDecision, WorkCompletion } from "../src/types.ts";

const scope = (decisions?: ContractDecision[]): Contract => ({
  title: "Status message", requirements: [{ id: "R1", text: "Add a status message field", sourceQuote: "Add a status message field" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title: "Message field", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["status.txt"],
    acceptance: [{ id: "AC1", text: "The field is stored", requirementIds: ["R1"], verification: "Read status.txt" }] }],
  ...(decisions ? { decisions } : {}),
});
const reply = (outcome: string, extra: object = {}) => ({
  outcome, summary: "Done", findings: [], questions: [],
  coverage: [{ requirementId: "R1", status: "addressed", evidence: "status.txt" }],
  checks: [{ description: "Read status.txt", outcome: "passed", evidence: "Inspected" }], ...extra,
});
const completion = (): WorkCompletion => ({
  summary: "All work complete", tasks: [{ taskId: "T1", evidence: "status.txt has the field" }],
  checks: [{ description: "Read status.txt", outcome: "passed", evidence: "Inspected" }], findings: [],
});
const waitFor = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(check(), `timed out waiting for ${what}`);
};
const profiles = {
  opus: { via: "claude", model: "claude-opus-5-5", effort: "medium" },
  sol: { via: "codex", model: "gpt-6.1-sol", effort: "medium" },
  ultra: { via: "codex", model: "gpt-6.1-sol", effort: "ultra" },
};

/** A planning handoff waiting, your agent config, and Pi with a scripted planner and reviewer. */
function run(t: TestContext, replies: object[], decisions?: ContractDecision[], spending?: { budgetUsd: number; costUsd: number }) {
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
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ profiles, roles: { planning: "opus", review: "sol" }, ...(spending ? { budget: { perSessionUsd: spending.budgetUsd } } : {}) }));
  writeFileSync(join(root, "status.txt"), "status\n");
  const s = createSession(root, "Add a status message field", undefined, "planning");
  prepare(root, s.id, scope(decisions), "planning", "Plan", 0);

  const commands = new Map<string, any>(), hooks = new Map<string, any>();
  const shown: any[] = [], notices: string[] = [], prompts: string[] = [], entries: any[] = [], agents: string[] = [];
  const agent: AgentRunner = async (program, args) => {
    agents.push(`${program} ${args.includes("gpt-6.1-sol") || args.some((a) => a.includes("gpt-6.1-sol")) ? "sol" : ""}${args.some((a) => a.includes("ultra")) ? " ultra" : ""}`.trim());
    const body = replies[agents.length - 1];
    if (body) submitRecipientReply(root, receiveHandoff(root, s.id).pin, body);
    // Each run reports its cost the way Claude does.
    const stdout = spending ? `${JSON.stringify({ type: "result", total_cost_usd: spending.costUsd, usage: { input_tokens: 10, output_tokens: 5 } })}\n` : "";
    return { stdout, stderr: "", code: 0, killed: false };
  };
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool() {}, on: (n: string, h: any) => hooks.set(n, h),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
    sendMessage: (m: any) => shown.push(m), sendUserMessage: (m: string) => prompts.push(m),
  } as unknown as ExtensionAPI, { runAgent: agent });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "pipeline-chat", getBranch: () => entries }, ui: { notify: (m: string) => notices.push(m) },
  } as unknown as ExtensionCommandContext;
  const latest = () => loadSession(root, s.id).rounds.at(-1)!.id;
  return {
    root, id: s.id, prompts, notices, agents,
    start: async (args: string) => { await commands.get("waicc-use").handler(s.id, ctx); await commands.get("waicc-dispatch").handler(args, ctx); },
    turnEnds: () => hooks.get("agent_end")({}, ctx),
    // What the main agent does in each turn.
    assess: (decision: "planned" | "followup" | "ready", rationale = "Checked against source") => assess(root, s.id, { requestId: latest(), decision, rationale, dispositions: [] }),
    requestReview: () => { writeFileSync(join(root, "status.txt"), "status with message\n"); issue(root, s.id, "review", "Review the whole change", undefined, undefined, { kind: "code", completion: completion() }); },
    messages: () => shown.filter((m) => m.customType === "waicc-review-loop").map((m) => m.content as string),
  };
}

for (const [flags, reviewer] of [["--review", "codex sol"], ["--review-with ultra", "codex sol ultra"]] as const)
  test(`--loop --develop ${flags}: plans with the planning profile, codes, then reviews with ${flags === "--review" ? "the review profile" : "the chosen profile"}`, async (t) => {
    const h = run(t, [reply("planned"), reply("planned"), reply("ready")]);
    await h.start(`--loop 2 --develop ${flags}`);
    await waitFor(() => h.prompts.length === 1, "the first plan's assessment");
    assert.match(h.prompts[0], /AUTOMATIC PLANNING LOOP, cycle 1 of 2, started by the human with \/waicc-dispatch --loop --develop/);
    h.assess("followup", "Cover the empty-message case");
    await h.turnEnds();
    await waitFor(() => h.prompts.length === 2, "the revised plan's assessment");
    assert.match(h.prompts[1], /cycle 2 of 2/);

    h.assess("planned");
    await h.turnEnds();
    await waitFor(() => h.prompts.length === 3, "the development instruction");
    assert.match(h.prompts[2], /authorized in-scope development/);
    assert.match(h.messages().at(-1)!, /Development authorized automatically, as you asked with --develop/);
    const s = loadSession(h.root, h.id);
    assert.match(artifact(h.root, s, s.implementationAuthorization!.artifactPath), /"origin": "human-dispatch-develop"/);

    await h.turnEnds(); // The main agent is still coding: nothing is dispatched yet.
    assert.equal(h.agents.length, 2);
    h.requestReview();
    await h.turnEnds();
    await waitFor(() => h.prompts.length === 4, "the review's assessment");
    assert.match(h.prompts[3], /AUTOMATIC REVIEW LOOP, cycle 1 of 2/);
    assert.deepEqual(h.agents, ["claude", "claude", reviewer], "planning and review use different profiles");

    h.assess("ready");
    await h.turnEnds();
    assert.match(h.messages().at(-1)!, /^Review passed after 1 cycle\. Nothing was closed/);
    assert.equal(loadSession(h.root, h.id).status, "READY_TO_CLOSE");
  });

test("--develop never starts coding while a decision is open, and a plan alone stops at PLAN_READY", async (t) => {
  const open: ContractDecision = { id: "D1", question: "Store messages forever?", owner: "human", status: "open", affectedTaskIds: ["T1"],
    evidence: ["status.txt keeps everything"], recommendation: "Keep 30 days", risk: "medium", reversible: true };
  const gated = run(t, [reply("planned")], [open]);
  await gated.start("--develop");
  await waitFor(() => gated.prompts.length === 1, "the assessment");
  gated.assess("planned");
  await gated.turnEnds();
  assert.match(gated.messages().at(-1)!, /Plan accepted after 1 cycle, but development was not started: D1 \(Store messages forever\?\) still needs your answer/);
  assert.equal(loadSession(gated.root, gated.id).implementationAuthorization ?? null, null);

  const plain = run(t, [reply("planned")]);
  await plain.start("--loop 3");
  await waitFor(() => plain.prompts.length === 1, "the assessment");
  plain.assess("planned");
  await plain.turnEnds();
  assert.match(plain.messages().at(-1)!, /^Plan accepted after 1 cycle \(PLAN_READY\)\. Run \/waicc-develop to start coding\./);
  assert.equal(loadSession(plain.root, plain.id).status, "PLAN_READY");
});

test("an automatic loop stops once the session reaches your budget; nothing more is dispatched", async (t) => {
  const h = run(t, [reply("planned"), reply("planned")], undefined, { budgetUsd: 1, costUsd: 1.5 });
  await h.start("--loop 3");
  await waitFor(() => h.prompts.length === 1, "the first plan's assessment");
  h.assess("followup", "Cover the empty-message case");
  await h.turnEnds();
  assert.match(h.messages().at(-1)!, /^Planning loop stopped after cycle 1\/3: this session's agents have reported \$1\.50, reaching your \$1 budget/);
  assert.equal(h.agents.length, 1, "the revised plan waits for you to dispatch it");
});
