import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
const completion = (findings: WorkCompletion["findings"] = []): WorkCompletion => ({
  summary: "All work complete", tasks: [{ taskId: "T1", evidence: "status.txt has the field" }],
  checks: [{ description: "Read status.txt", outcome: "passed", evidence: "Inspected" }], findings,
});
/** Every finding the reviews so far reported, fixed: what a fix's completion evidence must record. */
const fixes = (root: string, id: string): WorkCompletion["findings"] => loadSession(root, id).rounds
  .filter((round) => round.mode === "review")
  .flatMap((round) => (round.reply?.findings ?? []).map((f) => ({ requestId: round.id, findingId: f.id, disposition: "resolved" as const, evidence: "status.txt rejects empty messages" })));
const waitFor = async (check: () => boolean, what: string) => {
  // Coding runs snapshot a Git checkout and build a worktree, which can take seconds on Windows.
  for (const end = Date.now() + 30_000; Date.now() < end && !check();) await new Promise((done) => setTimeout(done, 10));
  assert.ok(check(), `timed out waiting for ${what}`);
};
const profiles = {
  opus: { via: "claude", model: "claude-opus-5-5", effort: "medium" },
  sol: { via: "codex", model: "gpt-6.1-sol", effort: "medium" },
  ultra: { via: "codex", model: "gpt-6.1-sol", effort: "ultra" },
};

/** A planning handoff waiting, your agent config, and Pi with a scripted planner and reviewer. */
type Scripted = object | ((root: string, id: string) => object);
function run(t: TestContext, replies: Scripted[], decisions?: ContractDecision[], spending?: { budgetUsd: number; costUsd: number }, coding?: { roles?: Record<string, string> }) {
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
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ profiles, roles: { planning: "opus", review: "sol", ...coding?.roles }, ...(spending ? { budget: { perSessionUsd: spending.budgetUsd } } : {}) }));
  // Coding agents work in an isolated copy of a Git checkout; only those tests pay for Git's slower snapshots.
  if (coding) execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  writeFileSync(join(root, "status.txt"), "status\n");
  const s = createSession(root, "Add a status message field", undefined, "planning");
  prepare(root, s.id, scope(decisions), "planning", "Plan", 0);

  const commands = new Map<string, any>(), hooks = new Map<string, any>();
  const shown: any[] = [], notices: string[] = [], prompts: string[] = [], entries: any[] = [], agents: string[] = [];
  const agent: AgentRunner = async (program, args) => {
    agents.push(`${program} ${args.includes("gpt-6.1-sol") || args.some((a) => a.includes("gpt-6.1-sol")) ? "sol" : ""}${args.some((a) => a.includes("ultra")) ? " ultra" : ""}`.trim());
    const scripted = replies[agents.length - 1];
    const body = typeof scripted === "function" ? scripted(root, s.id) : scripted;
    if (body) submitRecipientReply(root, receiveHandoff(root, s.id, true).pin, body);
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
    assess: (decision: "planned" | "followup" | "ready" | "needs_changes", rationale = "Checked against source") => assess(root, s.id, { requestId: latest(), decision, rationale, dispositions: [] }),
    requestCoding: (focus = "Complete ALL work") => { issue(root, s.id, "implementation", focus); },
    requestReview: () => { writeFileSync(join(root, "status.txt"), "status with message\n"); issue(root, s.id, "review", "Review the whole change", undefined, undefined, { kind: "code", completion: completion(fixes(root, s.id)) }); },
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

const coded = () => (root: string, id: string) => reply("ready", { completion: completion(fixes(root, id)) });
const finding = () => reply("needs_changes", { findings: [{ id: "F1", severity: "medium", description: "Empty messages are stored", evidence: "status.txt" }] });

test("--auto --code-with: the coding agent codes and fixes the review's findings; the main agent only assesses", async (t) => {
  const h = run(t, [reply("planned"), coded(), finding(), coded(), reply("ready")], undefined, undefined, {});
  await h.start("--auto --code-with ultra");
  await waitFor(() => h.prompts.length === 1, "the plan's assessment");
  h.assess("planned");
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 2, "the development instruction");
  assert.match(h.messages().at(-1)!, /preparing ONE coding handoff for the whole plan, which is dispatched to your ultra profile/);
  assert.equal(loadSession(h.root, h.id).implementationOwner, "delegate");

  await h.turnEnds(); // No coding handoff yet: nothing is dispatched.
  assert.equal(h.agents.length, 1);
  h.requestCoding();
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 3, "the implementation's assessment");
  assert.match(h.prompts[2], /AUTOMATIC RUN, coding round 1 of 3, .*Do NOT edit application code yourself/s);
  h.assess("ready");
  h.requestReview();
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 4, "the review's assessment");
  assert.match(h.prompts[3], /AUTOMATIC RUN, review 1 of 3, .*do NOT fix them yourself/s);

  h.assess("needs_changes");
  h.requestCoding("Fix ALL review findings");
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 5, "the fix's assessment");
  assert.match(h.prompts[4], /coding round 2 of 3/);
  h.assess("ready");
  h.requestReview();
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 6, "the second review's assessment");
  assert.deepEqual(h.agents, ["claude", "codex sol ultra", "codex sol", "codex sol ultra", "codex sol"], "coding and fixes by the chosen profile, reviews by the review role");

  h.assess("ready");
  await h.turnEnds();
  assert.match(h.messages().at(-1)!, /^Automatic run finished: the review passed \(2 coding rounds by your ultra profile, 2 reviews\)\. Nothing was closed/);
  assert.equal(loadSession(h.root, h.id).status, "READY_TO_CLOSE");
});

test("--review-once ends the run after one review, without fixing; --code-with uses the implementation role by default", async (t) => {
  const h = run(t, [reply("planned"), coded(), finding()], undefined, undefined, { roles: { implementation: "opus" } });
  await h.start("--auto --code-with --review-once");
  await waitFor(() => h.prompts.length === 1, "the plan's assessment");
  h.assess("planned");
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 2, "the development instruction");
  h.requestCoding();
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 3, "the implementation's assessment");
  h.assess("ready");
  h.requestReview();
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 4, "the review's assessment");
  assert.match(h.prompts[3], /ONE REVIEW, as the human asked with \/waicc-dispatch --review-once/);

  h.assess("needs_changes");
  h.requestCoding("Fix ALL review findings"); // Even if the main agent asks, the fix is not sent.
  await h.turnEnds();
  assert.match(h.messages().at(-1)!, /finished after its one review, as you asked with --review-once .*Nothing was fixed/);
  assert.deepEqual(h.agents, ["claude", "claude", "codex sol"]);
});

test("--auto --review-once: the main agent codes, one review runs, and nothing more is dispatched", async (t) => {
  const h = run(t, [reply("planned"), finding()]);
  await h.start("--auto --review-once");
  await waitFor(() => h.prompts.length === 1, "the plan's assessment");
  h.assess("planned");
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 2, "the development instruction");
  h.requestReview();
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 3, "the review's assessment");
  assert.match(h.prompts[2], /ONE REVIEW, as the human asked with \/waicc-dispatch --review-once/);
  h.assess("needs_changes");
  await h.turnEnds();
  assert.match(h.messages().at(-1)!, /^Run finished after its one review, as you asked with --review-once/);
  assert.deepEqual(h.agents, ["claude", "codex sol"]);
});

test("--code-with is refused before planning when no agent can code", async (t) => {
  const h = run(t, []);
  await h.start("--auto --code-with");
  assert.match(h.notices.at(-1)!, /--code-with needs a coding agent/);
  assert.equal(h.agents.length, 0);
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
