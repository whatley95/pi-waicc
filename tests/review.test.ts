import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { artifact, json, loadSession, sessionRelative } from "../src/files.ts";
import { roundDirectory } from "../src/render.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { snapshot } from "../src/source.ts";
import { amend, assess, cancel, closeSession, createSession, exportHandoff, ingest, issue, prepare, status } from "../src/workflow.ts";
import type { Contract, Reply, Session, WorkCompletion } from "../src/types.ts";

const scope: Contract = {
  title: "Search and account isolation",
  requirements: [{ id: "R1", text: "Search with account isolation", sourceQuote: "Add search with account isolation" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: ["API", "CLIENT"].map((id, i) => ({
    id, title: id, requirementIds: ["R1"], dependsOn: i ? ["API"] : [], allowedPaths: [`${id}.txt`],
    acceptance: [{ id: `AC${i}`, text: "Search respects account isolation", requirementIds: ["R1"], verification: "Run search regression checks" }],
  })),
};
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "waicc-code-review-")));
  t.after(() => {
    assert.equal(basename(root).startsWith("waicc-code-review-"), true);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "API.txt"), "original API");
  writeFileSync(join(root, "CLIENT.txt"), "original client");
  const s = createSession(root, "Add search with account isolation");
  return { root, id: s.id };
}
function reply(root: string, s: Session, updates: Partial<Reply> = {}) {
  const r = s.rounds.at(-1)!;
  const body: Reply = {
    ...JSON.parse(artifact(root, s, `${roundDirectory(r)}/reply.example.json`)),
    outcome: "ready", summary: "Independently inspected entire assigned scope",
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "API and CLIENT source and AC0/AC1 inspected" }],
    findings: [], questions: [],
    checks: [{ description: "Read API and CLIENT", outcome: "passed", evidence: "Source inspected; no runtime-test claim" }],
    ...updates,
  };
  writeFileSync(join(root, sessionRelative(s.id), roundDirectory(r), "reply.json"), json(body));
  return ingest(root, s.id);
}
function decide(root: string, s: Session, decision: "planned" | "ready" | "needs_changes" = "ready") {
  return assess(root, s.id, { requestId: s.rounds.at(-1)!.id, decision, rationale: "Checked source, scope and actual evidence", dispositions: [] });
}
function acceptedPlan(t: TestContext) {
  const { root, id } = fixture(t);
  const s = prepare(root, id, scope, "planning", "Inspect source and plan the entire objective", 0);
  return { root, s: decide(root, reply(root, s, { outcome: "planned" }), "planned") };
}
function completion(): WorkCompletion {
  return {
    summary: "ALL implementation and checks complete; independently verify these claims",
    tasks: scope.tasks.map((task) => ({ taskId: task.id, evidence: `${task.id}.txt implements its acceptance criteria; see check evidence` })),
    checks: [{ description: "Search regression checks", outcome: "passed", evidence: "Fixture evidence only; source review must independently establish production behavior" }],
    findings: [],
  };
}
function review(root: string, s: Session, report = completion(), taskId?: string) {
  return issue(root, s.id, "review", "Review ALL implementation and prior fixes", taskId, undefined, { kind: "code", completion: report });
}

test("main agent accepts one plan, completes all work, then sends ONE whole-change code review", (t) => {
  const { root, s } = acceptedPlan(t);
  assert.equal(s.status, "PLAN_READY");
  assert.equal(s.rounds.length, 1); // No external implementation handoff.
  const baseline = snapshot(root);
  writeFileSync(join(root, "API.txt"), "implemented API");
  writeFileSync(join(root, "CLIENT.txt"), "implemented client");
  const requested = review(root, s);
  assert.equal(requested.rounds.length, 2);
  const r = requested.rounds.at(-1)!;
  assert.equal(r.taskId, null);
  assert.equal(r.review!.kind, "code");
  if (r.review?.kind !== "code") throw new Error("Expected code context");
  assert.equal(r.review.base.fingerprint, baseline.fingerprint);
  assert.deepEqual(r.review.changedPaths, ["API.txt", "CLIENT.txt"]);
  const received = receiveHandoff(root, s.id);
  assert.equal(received.reviewKind, "code");
  assert.deepEqual(received.codeReview.completion, completion());
  assert.deepEqual(received.codeReview.changedPaths, ["API.txt", "CLIENT.txt"]);
  assert.equal(snapshot(root).fingerprint, r.source.fingerprint);
  assert.equal((status(root, s.id) as any).reviewKind, "code");
});

test("code review rejects incomplete/ambiguous reports, task batches and failed checks without mutations", (t) => {
  const { root, s } = acceptedPlan(t), before = loadSession(root, s.id);
  for (const report of [
    undefined,
    { ...completion(), tasks: completion().tasks.slice(0, 1) },
    { ...completion(), tasks: [completion().tasks[0], completion().tasks[0]] },
    { ...completion(), tasks: [{ taskId: "UNKNOWN", evidence: "not a planned task" }, completion().tasks[1]] },
    { ...completion(), tasks: [{ ...completion().tasks[0], status: "pending" }, completion().tasks[1]] },
    { ...completion(), checks: [] },
    { ...completion(), checks: [{ description: "Tests", outcome: "failed", evidence: "Failure is not done" }] },
    { ...completion(), checks: [{ description: "Tests", outcome: "passed", evidence: "" }] },
    { ...completion(), findings: [{ requestId: "other", findingId: "F1", disposition: "resolved", evidence: "Invented finding" }] },
  ]) {
    assert.throws(() => issue(root, s.id, "review", "Not ready", undefined, undefined, { kind: "code", completion: report }));
    assert.deepEqual(loadSession(root, s.id), before);
  }
  assert.throws(() => review(root, s, completion(), "API"), /ALL planned work/);
  assert.deepEqual(loadSession(root, s.id), before);
  assert.throws(() => issue(root, s.id, "planning", "Wrong mode", undefined, undefined, { kind: "code", completion: completion() }), /only apply to review/);
});

test("all genuine decision gates must be resolved before whole-work code review", (t) => {
  const { root, id } = fixture(t);
  const gated: Contract = { ...scope, decisions: [{ id: "D1", question: "Which product behavior?", owner: "human", status: "open", affectedTaskIds: ["CLIENT"], evidence: ["User choice not in source"], recommendation: "Wait for authorized answer" }] };
  let s = prepare(root, id, gated, "planning", "Plan with explicit future gate", 0);
  s = decide(root, reply(root, s, { outcome: "planned" }), "planned");
  assert.throws(() => review(root, s), /gated by unresolved/);
  assert.equal(loadSession(root, id).rounds.length, 1);
  const specification = issue(root, id, "review", "Specification only", undefined, undefined, { kind: "contract" });
  assert.equal(specification.rounds.at(-1)!.review!.kind, "contract");
});

test("failed code review goes to main agent; ALL fixes precede ONE full re-review with original baseline", (t) => {
  const { root, s: initial } = acceptedPlan(t);
  const baseline = snapshot(root);
  writeFileSync(join(root, "API.txt"), "all implementation v1");
  writeFileSync(join(root, "CLIENT.txt"), "all implementation v1");
  let s = review(root, initial);
  const first = s.rounds.at(-1)!.id;
  s = reply(root, s, { outcome: "needs_changes", findings: [
    { id: "F1", severity: "medium", description: "API regression", evidence: "API.txt violates AC0" },
    { id: "F2", severity: "low", description: "Client regression", evidence: "CLIENT.txt violates AC1" },
  ] });
  assert.throws(() => assess(root, s.id, { requestId: first, decision: "followup", rationale: "Review one fix next", dispositions: [] }), /finish ALL fixes/);
  s = assess(root, s.id, {
    requestId: first, decision: "needs_changes", rationale: "Adopt supported risk detail, then main agent fixes all code findings",
    contract: { ...scope, risks: ["Regression cases from the full code review"] }, dispositions: [],
  });
  assert.equal(s.contractVersion, 2);
  assert.equal(s.rounds.length, 2);
  assert.equal((status(root, s.id) as any).manualHandoff, null);
  assert.match((status(root, s.id) as any).nextAction, /ALL code-review findings/);
  writeFileSync(join(root, "API.txt"), "fixed API");
  const report = completion();
  report.findings = [{ requestId: first, findingId: "F1", disposition: "resolved", evidence: "API fix and regression evidence" }];
  assert.throws(() => review(root, s, report), /ALL review fixes/);
  assert.equal(loadSession(root, s.id).rounds.length, 2);
  writeFileSync(join(root, "CLIENT.txt"), "fixed client");
  report.findings.push({ requestId: first, findingId: "F2", disposition: "resolved", evidence: "Client fix and regression evidence" });
  s = review(root, s, report);
  assert.equal(s.rounds.length, 3);
  const context = s.rounds.at(-1)!.review;
  assert.equal(context?.kind, "code");
  if (context?.kind !== "code") throw new Error("Expected code review");
  assert.equal(context.base.fingerprint, baseline.fingerprint);
  assert.deepEqual(context.changedPaths, ["API.txt", "CLIENT.txt"]);
  s = decide(root, reply(root, s));
  assert.equal(s.status, "READY_TO_CLOSE");
  assert.equal(s.contractReview, "PASS");
  assert.equal(s.reviewApproval!.kind, "code");
  assert.equal(s.deliveryVerified, false);
  assert.equal((status(root, s.id) as any).reviewKind, "code");
  assert.equal(closeSession(root, s.id, "Whole-change review accepted").status, "CLOSED");
});

test("low/medium code findings cannot be waved through as fixed without a fresh review", (t) => {
  const { root, s } = acceptedPlan(t);
  let current = reply(root, review(root, s), { findings: [{ id: "F1", severity: "low", description: "Possible bug", evidence: "API.txt AC0" }] });
  assert.throws(() => decide(root, current), /Actionable code findings/);
  assert.throws(() => assess(root, s.id, { requestId: current.rounds.at(-1)!.id, decision: "ready", rationale: "Fixed it", dispositions: [{ findingId: "F1", disposition: "resolved", evidence: "Claim without fresh independent review" }] }), /Actionable code findings/);
  current = assess(root, s.id, { requestId: current.rounds.at(-1)!.id, decision: "ready", rationale: "Independent source evidence disproves finding", dispositions: [{ findingId: "F1", disposition: "disputed", evidence: "Exact call path and existing regression show AC0 is met" }] });
  assert.equal(current.status, "READY_TO_CLOSE");
});

test("every code-review cycle retains ALL older findings beyond three conversation rounds", (t) => {
  const { root, s: initial } = acceptedPlan(t);
  let s = initial;
  const report = completion();
  for (let cycle = 0; cycle < 4; cycle++) {
    s = review(root, s, report);
    const requestId = s.rounds.at(-1)!.id;
    s = decide(root, reply(root, s, { outcome: "needs_changes", findings: [{ id: "F1", severity: "medium", description: `Bug ${cycle}`, evidence: "API source evidence" }] }), "needs_changes");
    report.findings.push({ requestId, findingId: "F1", disposition: "resolved", evidence: `Fix ${cycle} and regression evidence` });
  }
  assert.throws(() => review(root, s, { ...report, findings: report.findings.slice(1) }), /ALL review fixes/);
  s = review(root, s, report);
  const history = JSON.parse(artifact(root, s, `${roundDirectory(s.rounds.at(-1)!)}/conversation.json`));
  assert.equal(history.filter((r: any) => r.reviewKind === "code").length, 4);
  assert.equal(history.find((r: any) => r.reviewKind === "code").findings[0].description, "Bug 0");
  assert.equal((status(root, s.id) as any).codeReviewFindings.length, 4);
});

test("standalone code review captures its scope atomically and records unavailable checks honestly", (t) => {
  const { root, id } = fixture(t), original = loadSession(root, id);
  assert.throws(() => prepare(root, id, scope, "review", "No completion evidence", 0, { kind: "code" }), /completion report/);
  assert.deepEqual(loadSession(root, id), original);
  const report = completion();
  report.checks = [{ description: "Device tests", outcome: "not_run", evidence: "No device available; reviewer must assess this required-evidence limit" }];
  const s = prepare(root, id, scope, "review", "Review existing changes across the entire scope", 0, { kind: "code", completion: report });
  assert.equal(s.contractVersion, 1);
  assert.equal(s.rounds.length, 1);
  assert.equal(receiveHandoff(root, id).codeReview.completion.checks[0].outcome, "not_run");
  assert.equal(s.deliveryVerified, false);
});

test("amended requirements cannot be silently reviewed against an outdated saved implementation plan", (t) => {
  const { root, s } = acceptedPlan(t);
  const amended = amend(root, s.id, "Also document the feature");
  assert.throws(() => review(root, amended), /Requirements changed after the saved plan/);
  assert.deepEqual(loadSession(root, s.id), amended);
});

test("code-review export carries full completion/baseline context and immutable evidence gates closure", (t) => {
  const { root, s: initial } = acceptedPlan(t);
  const s = review(root, initial), r = s.rounds.at(-1)!;
  const exported = exportHandoff(root, s.id);
  assert.deepEqual(JSON.parse(readFileSync(join(exported, "code-review.json"), "utf8")), r.review);
  const portable = readFileSync(join(exported, "HANDOFF.md"), "utf8");
  assert.match(portable, /code-review.json beside this file/);
  assert.equal(portable.includes(root), false);
  const a = receiveHandoff(root, s.id);
  submitRecipientReply(root, a.pin, {
    outcome: "ready", summary: "Independent whole-change source review",
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "AC0/AC1 source and available evidence inspected" }],
    findings: [], questions: [], checks: [{ description: "Source review", outcome: "passed", evidence: "Read API and CLIENT; no runtime claim" }],
  });
  decide(root, ingest(root, s.id));
  writeFileSync(join(root, sessionRelative(s.id), roundDirectory(r), "code-review.json"), "{}");
  assert.throws(() => closeSession(root, s.id, "Tampered evidence"), /modified/);
});

test("code review becomes stale when source changes; specification PASS stays explicitly contract-only", (t) => {
  const { root, s: initial } = acceptedPlan(t);
  const s = review(root, initial);
  writeFileSync(join(root, "API.txt"), "changed while review waited");
  assert.equal(reply(root, s).status, "STALE");
  let spec = issue(root, s.id, "review", "Explicit specification only", undefined, undefined, { kind: "contract" });
  spec = decide(root, reply(root, spec));
  assert.equal(spec.reviewApproval!.kind, "contract");
  assert.match((status(root, s.id) as any).nextAction, /Specification-only/);
});

test("CLI requires a whole-work completion file or explicit specification-only review", (t) => {
  const { root, s } = acceptedPlan(t), cli = resolve("src/cli.ts");
  const failed = spawnSync(process.execPath, [cli, "--root", root, "request", s.id, "review", "Premature review"], { encoding: "utf8", windowsHide: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /--completion/);
  assert.equal(loadSession(root, s.id).rounds.length, 1);
  // Keep the report in ignored runtime storage, not in the reviewed source inventory.
  const reportPath = join(root, sessionRelative(s.id), "completion-input.json");
  writeFileSync(reportPath, json(completion()));
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, "--root", root, ...args], { encoding: "utf8", windowsHide: true }));
  const code = run("request", s.id, "review", "--completion", reportPath, "Review the whole implementation");
  assert.equal(code.rounds.at(-1).review.kind, "code");
  cancel(root, s.id);
  const spec = run("request", s.id, "review", "--contract", "Only the specification");
  assert.equal(spec.rounds.at(-1).review.kind, "contract");
});
