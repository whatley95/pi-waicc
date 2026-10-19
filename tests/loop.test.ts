import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { loadSession } from "../src/files.ts";
import type { AgentRunner } from "../src/dispatch.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { assess, beginDevelopment, createSession, delegateWork, ingest, issue, prepare } from "../src/workflow.ts";
import type { Contract, WorkCompletion } from "../src/types.ts";

const scope: Contract = {
  title: "Search", requirements: [{ id: "R1", text: "Search with account isolation", sourceQuote: "Add search with account isolation" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "API", title: "API", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["API.txt"],
    acceptance: [{ id: "AC0", text: "Search respects account isolation", requirementIds: ["R1"], verification: "Run search regression checks" }] }],
};
const answer = (findings: { id: string; description: string }[] = [], outcome = findings.length ? "needs_changes" : "ready") => ({
  outcome, summary: "Independently inspected the whole change",
  coverage: [{ requirementId: "R1", status: "addressed", evidence: "API.txt and AC0 inspected" }],
  findings: findings.map((finding) => ({ ...finding, severity: "medium", evidence: "API.txt violates AC0" })),
  questions: [], checks: [{ description: "Read API", outcome: "passed", evidence: "Source inspected" }],
});
const report = (): WorkCompletion => ({
  summary: "All work complete", tasks: [{ taskId: "API", evidence: "API.txt implements AC0" }],
  checks: [{ description: "Search regression checks", outcome: "passed", evidence: "Fixture evidence" }], findings: [],
});
const waitFor = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(check(), `timed out waiting for ${what}`);
};

/** An accepted plan, authorized for development, implemented, with one whole-change code review waiting. */
function reviewWaiting(t: TestContext, options: { authorize?: boolean; owner?: "main" | "delegate" } = {}) {
  assert.match(process.env.PI_CODING_AGENT_DIR ?? "", /waicc-agent-dir-/, "tests never read your own agent config");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "API.txt"), "original API");
  const s = createSession(root, "Add search with account isolation", undefined, "planning");
  prepare(root, s.id, scope, "planning", "Plan", 0);
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, answer([], "planned"));
  const planned = ingest(root, s.id);
  assess(root, s.id, { requestId: planned.rounds.at(-1)!.id, decision: "planned", rationale: "Checked", dispositions: [] });
  if (options.authorize !== false) beginDevelopment(root, s.id, options.owner ?? "main");
  writeFileSync(join(root, "API.txt"), "implemented API");
  issue(root, s.id, "review", "Review the whole change", undefined, undefined, { kind: "code", completion: report() });
  return { root, id: s.id };
}

/** Pi with a scripted reviewer: each dispatch submits the next scripted review reply. */
function harness(root: string, replies: ReturnType<typeof answer>[]) {
  const commands = new Map<string, any>(), hooks = new Map<string, any>();
  const shown: any[] = [], notices: string[] = [], prompts: string[] = [], entries: any[] = [];
  let dispatched = 0;
  const reviewer: AgentRunner = async () => {
    const body = replies[dispatched++];
    if (body) submitRecipientReply(root, receiveHandoff(root, loadSession(root, sessionId).id).pin, body);
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  let sessionId = "";
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool() {}, on: (n: string, h: any) => hooks.set(n, h),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
    sendMessage: (m: any) => shown.push(m), sendUserMessage: (m: string) => prompts.push(m),
  } as unknown as ExtensionAPI, { runAgent: reviewer });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "loop-chat", getBranch: () => entries },
    ui: { notify: (m: string) => notices.push(m) },
  } as unknown as ExtensionCommandContext;
  return {
    ctx, shown, notices, prompts, dispatched: () => dispatched,
    use: (id: string) => { sessionId = id; return commands.get("waicc-use").handler(id, ctx); },
    dispatch: (args: string) => commands.get("waicc-dispatch").handler(args, ctx),
    turnEnds: () => hooks.get("agent_end")({}, ctx),
    loopMessages: () => shown.filter((m) => m.customType === "waicc-review-loop").map((m) => m.content as string),
  };
}
/** What the main agent does with a needs-changes review: assess, fix every finding, request a fresh review. */
function mainAgentFixes(root: string, id: string, resolved: { findingId: string }[]) {
  const s = loadSession(root, id), requestId = s.rounds.at(-1)!.id;
  assess(root, id, { requestId, decision: "needs_changes", rationale: "Findings verified against source", dispositions: [] });
  writeFileSync(join(root, "API.txt"), `fixed API ${Date.now()}`);
  const completion = report();
  completion.findings = resolved.map(({ findingId }) => ({ requestId, findingId, disposition: "resolved", evidence: "Fixed with regression evidence" }));
  issue(root, id, "review", "Review the whole change again", undefined, undefined, { kind: "code", completion });
}
const mainAgentAccepts = (root: string, id: string) =>
  assess(root, id, { requestId: loadSession(root, id).rounds.at(-1)!.id, decision: "ready", rationale: "Independently verified", dispositions: [] });

test("--loop reviews, lets the main agent fix, re-reviews automatically and stops on a pass without closing", async (t) => {
  const { root, id } = reviewWaiting(t);
  const h = harness(root, [answer([{ id: "F1", description: "Missing account check" }]), answer()]);
  await h.use(id);
  await h.dispatch("--via codex --loop");
  await waitFor(() => h.prompts.length === 1, "the first assessment");
  assert.match(h.prompts[0], /AUTOMATIC REVIEW LOOP, cycle 1 of 3/);
  assert.match(h.prompts[0], /Never close the contract/);

  mainAgentFixes(root, id, [{ findingId: "F1" }]);
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 2, "the second assessment");
  assert.equal(h.dispatched(), 2, "the fresh review was dispatched automatically");
  assert.match(h.prompts[1], /cycle 2 of 3/);

  mainAgentAccepts(root, id);
  await h.turnEnds();
  assert.match(h.loopMessages().at(-1)!, /Review passed after 2 cycles\. Nothing was closed/);
  assert.equal(loadSession(root, id).status, "READY_TO_CLOSE");
  await h.turnEnds();
  assert.equal(h.dispatched(), 2, "a finished loop dispatches nothing more");
});

test("the loop stops when the same findings return, when no fresh review is requested, and at its cap", async (t) => {
  const repeated = reviewWaiting(t);
  const same = [{ id: "F1", description: "Missing account check" }];
  const a = harness(repeated.root, [answer(same), answer(same)]);
  await a.use(repeated.id);
  await a.dispatch("--via codex --loop 3");
  await waitFor(() => a.prompts.length === 1, "assessment 1");
  mainAgentFixes(repeated.root, repeated.id, [{ findingId: "F1" }]);
  await a.turnEnds();
  await waitFor(() => a.prompts.length === 2, "assessment 2");
  assert.match(a.loopMessages().at(-1)!, /same findings came back/);
  assert.doesNotMatch(a.prompts[1], /AUTOMATIC REVIEW LOOP/, "assessed normally, without asking for another review");

  const stalled = reviewWaiting(t);
  const b = harness(stalled.root, [answer([{ id: "F1", description: "Needs a product decision" }])]);
  await b.use(stalled.id);
  await b.dispatch("--via codex --loop");
  await waitFor(() => b.prompts.length === 1, "assessment");
  await b.turnEnds(); // Another turn ended before the assessment ran: keep waiting.
  assert.equal(b.loopMessages().length, 0);
  assess(stalled.root, stalled.id, { requestId: loadSession(stalled.root, stalled.id).rounds.at(-1)!.id, decision: "needs_changes", rationale: "F1 needs the human", dispositions: [] });
  await b.turnEnds();
  assert.match(b.loopMessages().at(-1)!, /did not ask for a fresh review, so something needs you/);

  const capped = reviewWaiting(t);
  const c = harness(capped.root, [answer([{ id: "F1", description: "Missing account check" }])]);
  await c.use(capped.id);
  await c.dispatch("--via codex --loop 1");
  await waitFor(() => c.prompts.length === 1, "assessment");
  mainAgentFixes(capped.root, capped.id, [{ findingId: "F1" }]);
  await c.turnEnds();
  assert.match(c.loopMessages().at(-1)!, /reached its limit of 1 cycles\. A fresh review is waiting/);
  assert.equal(c.dispatched(), 1);
});

test("--continue assesses automatically; --loop needs a code review; --stop ends a loop", async (t) => {
  const { root, id } = reviewWaiting(t);
  const h = harness(root, [answer()]);
  await h.use(id);
  await h.dispatch("--via codex --continue");
  await waitFor(() => h.prompts.length === 1, "automatic continue");
  assert.match(h.prompts[0], /Assess the reply BEFORE application edits/);
  assert.doesNotMatch(h.prompts[0], /AUTOMATIC REVIEW LOOP/);
  assert.match(h.notices.find((notice) => /submitted a reply/.test(notice))!, /Continuing automatically/);

  const planning = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => rmSync(planning, { recursive: true, force: true }));
  writeFileSync(join(planning, "API.txt"), "x");
  const p = createSession(planning, "Add search with account isolation", undefined, "planning");
  prepare(planning, p.id, scope, "planning", "Plan", 0);
  const ph = harness(planning, []);
  await ph.use(p.id);
  // --review needs --develop, and --develop needs a planning handoff; nothing is dispatched.
  await ph.dispatch("--via codex --loop --review");
  assert.match(ph.notices.at(-1)!, /--review continues a planning run through development into the code review, so it needs --develop/);
  assert.equal(ph.dispatched(), 0);

  const stopping = reviewWaiting(t);
  const s = harness(stopping.root, [answer([{ id: "F1", description: "Missing account check" }])]);
  await s.use(stopping.id);
  await s.dispatch("--via codex --loop");
  await waitFor(() => s.prompts.length === 1, "assessment");
  await s.dispatch("--stop");
  assert.match(s.loopMessages().at(-1)!, /Review loop stopped by you at cycle 1\/3/);
  mainAgentFixes(stopping.root, stopping.id, [{ findingId: "F1" }]);
  await s.turnEnds();
  assert.equal(s.dispatched(), 1, "a stopped loop never dispatches again");
});

test("--loop refuses at once without development authorization or when fixes are delegated", async (t) => {
  const unauthorized = reviewWaiting(t, { authorize: false });
  const a = harness(unauthorized.root, [answer()]);
  await a.use(unauthorized.id);
  await a.dispatch("--via codex --loop");
  assert.match(a.notices.at(-1)!, /--loop needs development authorization, because the main agent fixes findings between reviews. No recorded development authorization/);
  assert.equal(a.dispatched(), 0, "no review cycle is spent finding that out");
  // Without --loop the same review can still be dispatched.
  await a.dispatch("--via codex");
  await waitFor(() => a.dispatched() === 1, "a plain dispatch");

  const delegated = reviewWaiting(t, { owner: "delegate" });
  const b = harness(delegated.root, [answer()]);
  await b.use(delegated.id);
  await b.dispatch("--via codex --loop");
  assert.match(b.notices.at(-1)!, /implementation is delegated in this session/);
  assert.equal(b.dispatched(), 0);
});
