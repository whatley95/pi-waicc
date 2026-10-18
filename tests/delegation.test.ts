import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { artifact, json, loadSession, sessionRelative } from "../src/files.ts";
import { checkCommand, runRecipientCheck } from "../src/checks.ts";
import { curate, propose } from "../src/memory.ts";
import { assertRecipientEdit, receiveHandoff, recipientAssignment, submitRecipientReply } from "../src/recipient.ts";
import { roundDirectory } from "../src/render.ts";
import { snapshot } from "../src/source.ts";
import { amend, assess, cancel, closeSession, createSession, delegateWork, exportHandoff, forceCloseSession, ingest, issue, prepare, saveContext, status, useMainWork } from "../src/workflow.ts";
import type { Contract, Mode, Reply, Session, WorkCompletion } from "../src/types.ts";

const contract: Contract = {
  title: "Account search", requirements: [{ id: "R1", text: "Account search", sourceQuote: "Add account search" }],
  exclusions: ["Production deployment"], assumptions: [], risks: [], questions: [], skills: ["wai-node"],
  tasks: [{ id: "SEARCH", title: "Implement all search behavior", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["source.txt"],
    acceptance: [{ id: "AC1", text: "Search is account scoped", requirementIds: ["R1"], verification: "Run account isolation checks" }] }],
};
const check = { description: "Account isolation tests", outcome: "passed" as const, evidence: "Fixture test evidence; no production behavior claim" };
function report(): WorkCompletion {
  return { summary: "Entire implementation and all fixes complete", tasks: [{ taskId: "SEARCH", evidence: "source.txt implements AC1" }], checks: [check], findings: [] };
}
function fixture(t: TestContext, delegated = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "waicc-delegation-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-delegation-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "original source");
  const original = createSession(root, "Add account search", delegated ? "delegate" : undefined);
  saveContext(root, original.id, "Keep existing API shape. Owner confirmed account isolation; source.txt is the entry point. No deployment.");
  curate(root, propose(root, "Account search must be scoped", "source.txt", "decision").id, "confirm");
  propose(root, "Account search speculative lesson", "source.txt");
  return { root, s: prepare(root, original.id, contract, "planning", "Inspect account search", 0) };
}
function answer(root: string, s: Session, changes: Partial<Reply> = {}) {
  const r = s.rounds.at(-1)!;
  const body = {
    outcome: "ready", summary: "Examined entire assigned scope", questions: [], findings: [], checks: [check],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "source.txt and AC1 inspected" }],
    ...changes,
  };
  const pin = { sessionId: s.id, requestId: r.id, contractVersion: r.contractVersion,
    requirementsDigest: r.requirementsDigest, sourceFingerprint: r.source.fingerprint, mode: r.mode };
  submitRecipientReply(root, pin, body);
  return ingest(root, s.id);
}
function decide(root: string, s: Session, decision: "planned" | "ready" | "needs_changes" = "ready") {
  return assess(root, s.id, { requestId: s.rounds.at(-1)!.id, decision, rationale: "Source and evidence independently checked", dispositions: [] });
}
function plan(t: TestContext, delegated = false) {
  const { root, s } = fixture(t, delegated);
  return { root, s: decide(root, answer(root, s, { outcome: "planned" }), "planned") };
}

test("every role receives pinned coordinator context, confirmed-only memory and complete saved history", (t) => {
  for (const mode of ["planning", "implementation", "testing", "review", "advisor"] as Mode[]) {
    const { root, s: initial } = fixture(t);
    let s = initial;
    if (mode !== "planning") {
      s = decide(root, answer(root, s, { outcome: "planned" }), "planned");
      if (mode === "implementation" || mode === "testing") s = delegateWork(root, s.id, mode, "Complete the whole assignment");
      else if (mode === "review") s = issue(root, s.id, mode, "Review entire implementation", undefined, undefined, { kind: "code", completion: report() });
      else s = issue(root, s.id, "advisor", "Compare account search options");
    }
    const a = receiveHandoff(root, s.id, mode === "implementation"), r = s.rounds.at(-1)!;
    assert.equal(a.context.identity.requestId, r.id);
    assert.equal(a.context.identity.sourceFingerprint, r.source.fingerprint);
    assert.match(a.context.coordinatorContext.summary, /Keep existing API shape/);
    assert.deepEqual(a.memory.map((memory) => memory.text), ["Account search must be scoped"]);
    assert.equal(a.context.decisions.length, 0);
    const before = loadSession(root, s.id);
    assert.throws(() => saveContext(root, s.id, "Change context while worker is pinned"), /pending handoff/);
    assert.deepEqual(loadSession(root, s.id), before);
    const portable = exportHandoff(root, s.id);
    for (const name of ["CONTEXT.md", "context.json", "memory.json"])
      assert.equal(readFileSync(join(portable, name), "utf8"), artifact(root, s, `${roundDirectory(r)}/${name}`));
    assert.ok(existsSync(join(portable, "skills/waicc-workflow/SKILL.md")));
    if (mode === "implementation" || mode === "testing") assert.ok(existsSync(join(portable, "skills/wai-testing/SKILL.md")));
    const late = propose(root, "Account search late confirmed detail", "source.txt");
    curate(root, late.id, "confirm");
    assert.equal(recipientAssignment(root, a.pin).memory.length, 1); // Frozen at issue, not a live query.
  }
});

test("planning context preserves earlier proposed plans as advice without silently adopting them", (t) => {
  const { root, s: initial } = fixture(t);
  const proposal = { ...contract, risks: ["Earlier investigation identified an account-isolation race"] };
  let s = answer(root, initial, { outcome: "needs_changes", proposedContract: proposal });
  s = decide(root, s, "needs_changes");
  s = issue(root, s.id, "planning", "Investigate the prior proposal against source");
  const a = receiveHandoff(root, s.id);
  assert.deepEqual(a.conversation.at(-1).proposedContract, proposal);
  assert.deepEqual(a.contract.contract.risks, []);
  assert.equal(a.context.priorRounds.at(-1).decision, "needs_changes");
});

test("delegation needs a current accepted plan, explicit ownership, whole scope and no pending handoff", (t) => {
  const { root, s: pending } = fixture(t);
  assert.throws(() => delegateWork(root, pending.id, "implementation", "Not accepted"), /Accept a current planning reply/);
  let s = decide(root, answer(root, pending, { outcome: "planned" }), "planned");
  assert.throws(() => issue(root, s.id, "implementation", "No human choice"), /explicit \/waicc-help-develop/);
  assert.throws(() => issue(root, s.id, "testing", "No human choice"), /requires \/waicc-test/);
  s = delegateWork(root, s.id, "implementation", "Implement everything");
  assert.equal(s.implementationOwner, "delegate");
  assert.equal(s.rounds.at(-1)!.wholeWork, true);
  assert.equal(s.rounds.at(-1)!.taskId, null);
  assert.throws(() => delegateWork(root, s.id, "testing", "Already pending"), /pending request/);
  cancel(root, s.id);
  assert.throws(() => issue(root, s.id, "implementation", "One task only", "SEARCH"), /whole plan/);
  const draft = prepare(root, s.id, { ...contract, risks: ["Unaccepted new draft"] }, "planning", "Reconsider plan", 1);
  cancel(root, s.id);
  assert.throws(() => delegateWork(root, s.id, "implementation", "Do not execute unaccepted drafts"), /current planning/);
  assert.equal(draft.planApproval, null);
  const amended = amend(root, s.id, "Also update the docs");
  assert.throws(() => delegateWork(root, s.id, "implementation", "Outdated plan"), /current planning/);
  assert.deepEqual(loadSession(root, s.id), amended);
});

test("coding/testing delegation is optional and the human can switch back to main without another handoff", (t) => {
  const { root, s: accepted } = plan(t);
  assert.equal((status(root, accepted.id) as any).implementationOwner, "main");
  assert.equal((status(root, accepted.id) as any).testingOwner, "main");
  let s = delegateWork(root, accepted.id, "implementation", "Delegate coding by choice");
  const pending = loadSession(root, s.id);
  assert.throws(() => useMainWork(root, s.id, "implementation"), /pending handoff/);
  assert.deepEqual(loadSession(root, s.id), pending);
  cancel(root, s.id);
  s = useMainWork(root, s.id, "implementation");
  assert.equal(s.implementationOwner, "main");
  assert.equal(s.rounds.length, 2);
  assert.throws(() => issue(root, s.id, "implementation", "Do not silently re-delegate"), /explicit \/waicc-help-develop/);
  s = delegateWork(root, s.id, "testing", "Optional independent testing");
  cancel(root, s.id);
  s = useMainWork(root, s.id, "testing");
  assert.equal(s.testingOwner, "main");
  assert.equal(s.rounds.length, 3);
  assert.equal((status(root, s.id) as any).manualHandoff, null);
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "original source");
});

test("implementation report covers all work; coordinator may choose testing before ONE independent code review", (t) => {
  const { root, s: accepted } = plan(t, true);
  let s = issue(root, accepted.id, "implementation", "Complete ALL work");
  const pin = receiveHandoff(root, s.id, true).pin;
  writeFileSync(join(root, "source.txt"), "all implementation");
  const body = { outcome: "ready", summary: "Implemented search", findings: [], questions: [],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "AC1 implemented in source.txt" }],
    checks: [{ description: "Runtime tests", outcome: "not_run", evidence: "No execution permission in coding session" }] };
  assert.throws(() => submitRecipientReply(root, pin, body), /completion evidence for ALL/);
  assert.throws(() => submitRecipientReply(root, pin, { ...body, completion: { ...report(), tasks: [], checks: body.checks } }), /ALL planned tasks/);
  assert.throws(() => submitRecipientReply(root, pin, { ...body, completion: report() }), /checks must match/);
  s = answer(root, s, { ...body as Partial<Reply>, completion: { ...report(), checks: body.checks as WorkCompletion["checks"] } });
  assert.equal(s.status, "AWAITING_ASSESSMENT");
  s = decide(root, s);
  assert.equal(s.status, "NEEDS_TESTING");
  assert.equal(s.rounds.length, 2);
  assert.equal(s.contractReview, "NOT_REVIEWED");
  s = delegateWork(root, s.id, "testing", "Test all implementation; no fixes");
  const tester = receiveHandoff(root, s.id);
  assert.throws(() => assertRecipientEdit(root, tester.pin, "source.txt"), /cannot edit/);
  s = decide(root, answer(root, s));
  assert.equal(s.status, "NEEDS_REVIEW");
  assert.equal(s.contractReview, "NOT_REVIEWED");
  assert.equal(s.rounds.length, 3);
  assert.throws(() => closeSession(root, s.id, "Testing is not code review"), /READY_TO_CLOSE/);
  s = issue(root, s.id, "review", "Review the full implemented change", undefined, undefined, { kind: "code", completion: report() });
  s = decide(root, answer(root, s));
  assert.equal(s.status, "READY_TO_CLOSE");
  assert.equal(s.reviewApproval!.kind, "code");
});

test("external coding reports normalize check aliases in both locations with raw evidence preserved and no automatic approval", (t) => {
  const { root, s: accepted } = plan(t, true);
  const s = issue(root, accepted.id, "implementation", "Return whole-work evidence");
  const a = receiveHandoff(root, s.id, true);
  const rawCheck = { name: "Regression", status: "pass", evidence: ["Actual fixture check result"], command: "node regression.js" };
  submitRecipientReply(root, a.pin, {
    outcome: "ready", summary: "Reported all work done; requires owner verification", questions: [], findings: [],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "Reported AC1 implementation" }],
    checks: [rawCheck], completion: { ...report(), checks: [rawCheck], tasks: [{ taskId: "SEARCH", evidence: ["Source/acceptance evidence claim"] }] },
  });
  const received = ingest(root, s.id), r = received.rounds.at(-1)!;
  assert.equal(received.status, "AWAITING_ASSESSMENT");
  assert.equal(received.contractReview, "NOT_REVIEWED");
  assert.equal(received.deliveryVerified, false);
  assert.equal(r.reply!.checks[0].outcome, "passed");
  assert.equal(r.reply!.completion!.checks[0].outcome, "passed");
  assert.equal(r.reply!.completion!.checks[0].extensions!.command, "node regression.js");
  assert.ok(artifact(root, received, `${roundDirectory(r)}/received.json`).includes('"status": "pass"'));
});

test("failed testing returns ALL findings to the selected implementer; test replies cannot revise scope or claim unexecuted readiness", (t) => {
  const { root, s: accepted } = plan(t, true);
  let s = delegateWork(root, accepted.id, "testing", "Test whole implementation");
  const a = receiveHandoff(root, s.id), template = { outcome: "ready", summary: "Tests", findings: [], questions: [], coverage: [{ requirementId: "R1", status: "addressed", evidence: "Scope inspected" }], checks: [{ ...check, outcome: "not_run" }] };
  assert.throws(() => submitRecipientReply(root, a.pin, template), /actual executed check/);
  assert.throws(() => submitRecipientReply(root, a.pin, { ...template, proposedContract: contract }), /replacement contracts/);
  s = answer(root, s, { outcome: "needs_changes", checks: [{ ...check, outcome: "failed" }], findings: [{ id: "F1", severity: "medium", description: "Account scope regression", evidence: "Actual test case failure" }] });
  s = decide(root, s, "needs_changes");
  assert.equal(s.status, "NEEDS_CHANGES");
  assert.equal(s.rounds.length, 2);
  assert.equal((status(root, s.id) as any).manualHandoff, null);
  s = issue(root, s.id, "implementation", "Fix ALL test defects and rerun checks");
  const context = receiveHandoff(root, s.id, true).context;
  assert.equal(context.priorFindings.at(-1).id, "F1");
  assert.equal(context.priorChecks.at(-1).outcome, "failed");
});

test("source-changing test execution is logged as failed, never accepted against stale source", async (t) => {
  const { root, s: accepted } = plan(t);
  const s = delegateWork(root, accepted.id, "testing", "Test only"), a = receiveHandoff(root, s.id);
  const result = await runRecipientCheck(root, a.pin, checkCommand({ program: "test-runner", args: [], timeoutMs: 1000 }), snapshot(root).fingerprint,
    async () => { writeFileSync(join(root, "source.txt"), "unexpected generated source mutation"); return { stdout: "ok", stderr: "", code: 0, killed: false }; });
  assert.equal(result.outcome, "failed");
  assert.equal(result.sourceChanged, true);
  assert.equal(result.code, 0); // Successful process is not a source-current testing pass.
  assert.ok(result.artifactPath);
  assert.equal(JSON.parse(artifact(root, loadSession(root, s.id), result.artifactPath!)).sourceChanged, true);
  assert.throws(() => submitRecipientReply(root, a.pin, { outcome: "blocked", summary: "Changed source", findings: [], questions: [], coverage: [], checks: [] }), /Source changed/);
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "unexpected generated source mutation"); // Never destructive auto-revert.
});

test("confirmed checks log exact commands/output/source, failures and timeout; later roles/export get immutable evidence", async (t) => {
  const { root, s: accepted } = plan(t);
  let s = delegateWork(root, accepted.id, "testing", "Run all checks");
  const a = receiveHandoff(root, s.id), fingerprint = snapshot(root).fingerprint;
  const command = checkCommand({ program: "runner", args: ["test", "argument with spaces"] });
  const first = await runRecipientCheck(root, a.pin, command, fingerprint, async (program, args, options) => {
    assert.equal(program, command.program); assert.deepEqual(args, command.args); assert.equal(options.cwd, root);
    return { stdout: "all tests passed", stderr: "", code: 0, killed: false };
  });
  assert.equal(first.outcome, "passed");
  const second = await runRecipientCheck(root, a.pin, command, fingerprint, async () => ({ stdout: "partial output", stderr: "timed out", code: 0, killed: true }));
  assert.equal(second.outcome, "failed");
  const failedStart = await runRecipientCheck(root, a.pin, command, fingerprint, async () => { throw new Error("Missing executable"); });
  assert.equal(failedStart.outcome, "failed");
  s = answer(root, loadSession(root, s.id), { outcome: "blocked", checks: [{ ...check, outcome: "failed", evidence: `${second.artifactPath}: timeout` }] });
  s = assess(root, s.id, { requestId: a.pin.requestId, decision: "blocked", rationale: "Check environment needs repair", dispositions: [] });
  s = issue(root, s.id, "advisor", "How should the check environment be repaired?");
  const context = receiveHandoff(root, s.id).context;
  const reference = context.checkEvidence.find((entry: any) => entry.path.endsWith(first.artifactPath!));
  assert.ok(reference);
  const exported = exportHandoff(root, s.id);
  assert.equal(JSON.parse(readFileSync(join(exported, reference.path), "utf8")).stdout, "all tests passed");
});

test("check permission races, invalid commands and closed histories fail safely without retargeting", async (t) => {
  const { root, s: accepted } = plan(t), s = delegateWork(root, accepted.id, "testing", "Check"), a = receiveHandoff(root, s.id);
  for (const command of [{ program: "runner\nmalicious", args: [] }, { program: "runner", args: [42] }, { program: "runner", args: [], timeoutMs: 100000 }, { program: "runner", args: [], shell: true }])
    assert.throws(() => checkCommand(command));
  let called = false;
  await assert.rejects(() => runRecipientCheck(root, a.pin, checkCommand({ program: "runner", args: [] }), "stale approval", async () => { called = true; return { stdout: "", stderr: "", code: 0, killed: false }; }), /Source changed while/);
  assert.equal(called, false);
  const result = await runRecipientCheck(root, a.pin, checkCommand({ program: "runner", args: [] }), snapshot(root).fingerprint, async () => {
    forceCloseSession(root, s.id); return { stdout: "finished", stderr: "", code: 0, killed: false };
  });
  assert.equal(result.artifactPath, null);
  const closed = loadSession(root, s.id);
  assert.equal(closed.status, "CLOSED");
  assert.equal(Object.keys(closed.artifacts).filter((path) => path.endsWith("result.json")).length, 0);
});

test("CLI supports delegated planning, implementation and optional testing with the same context packet", (t) => {
  const { root, s } = plan(t), cli = resolve("src/cli.ts");
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, "--root", root, ...args], { encoding: "utf8", windowsHide: true }));
  const another = run("start", "--delegate", "Another coding objective");
  assert.equal(another.implementationOwner, "delegate");
  assert.equal(another.requirements[0], "Another coding objective");
  for (const command of ["help-develop", "implement"]) {
    const implementation = run(command, s.id);
    assert.equal(implementation.rounds.at(-1).mode, "implementation");
    assert.equal(implementation.rounds.at(-1).wholeWork, true);
    cancel(root, s.id);
    const main = run(command, s.id, "--main");
    assert.equal(main.implementationOwner, "main");
    assert.equal(main.rounds.length, implementation.rounds.length);
  }
  const testing = run("test", s.id);
  assert.equal(testing.rounds.at(-1).mode, "testing");
  assert.equal(testing.testingOwner, "delegate");
});
