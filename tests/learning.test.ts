import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { learnPattern, recurringFindings } from "../src/learning.ts";
import { curate, memoryStates, recall } from "../src/memory.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { projectStatus } from "../src/tracker.ts";
import { assess, createSession, ingest, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const contract = (title: string): Contract => ({
  title, requirements: [{ id: "R1", text: title, sourceQuote: title }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title, requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"],
    acceptance: [{ id: "AC1", text: "Works", requirementIds: ["R1"], verification: "Run the tests" }] }],
});

function project(t: TestContext) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const root = join(base, "project");
  mkdirSync(root);
  t.after(() => {
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  writeFileSync(join(root, "app.txt"), "app");
  return root;
}
/** A session whose review came back with these findings and was assessed, disputing some. */
function reviewed(root: string, title: string, findings: [string, string][], disputed: string[] = []) {
  const s = createSession(root, title);
  prepare(root, s.id, contract(title), "review", "Review the plan", 0);
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "needs_changes", summary: "Changes needed", questions: [],
    findings: findings.map(([id, description]) => ({ id, severity: "medium", description, evidence: "app.txt" })),
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
    checks: [{ description: "Read app.txt", outcome: "passed", evidence: "Inspected" }],
  });
  const received = ingest(root, s.id);
  const requestId = received.rounds.at(-1)!.id;
  assess(root, s.id, { requestId, decision: "needs_changes", rationale: "Valid findings",
    dispositions: disputed.map((findingId) => ({ findingId, disposition: "disputed" as const, evidence: "Not a real problem" })) });
  return { id: s.id, requestId };
}

test("after a review, findings from other sessions that resemble it are offered for the main agent to judge", (t) => {
  const root = project(t);
  const first = reviewed(root, "Add order search", [["F1", "No test covers searching with an empty query"], ["F2", "Search results are not paginated"]], ["F2"]);
  const second = reviewed(root, "Add customer filter", [["F1", "Missing tests for an empty filter value"]]);

  const offer = recurringFindings(root, second.id, second.requestId)!;
  assert.deepEqual(offer.thisReview.map((f) => f.findingId), ["F1"]);
  assert.deepEqual(offer.earlierFindings.map((f) => [f.sessionId, f.findingId, f.resembles]), [[first.id, "F1", "F1"]], "the disputed finding is left out");
  assert.ok(offer.earlierFindings[0].similarity > 0);
  assert.match(offer.instruction, /waicc_learn_pattern/);
  assert.equal(recurringFindings(root, first.id, "not-this-request"), null, "nothing to compare without findings");
});

test("a lesson needs findings from two sessions, uses each finding once, and stays a candidate until the human confirms it", (t) => {
  const root = project(t);
  const first = reviewed(root, "Add order search", [["F1", "No test covers searching with an empty query"], ["F2", "Search results are not paginated"]], ["F2"]);
  const second = reviewed(root, "Add customer filter", [["F1", "Missing tests for an empty filter value"]]);
  const a = { sessionId: first.id, requestId: first.requestId, findingId: "F1" };
  const b = { sessionId: second.id, requestId: second.requestId, findingId: "F1" };
  const lesson = "Plan a test for empty input on every new search or filter";

  assert.throws(() => learnPattern(root, lesson, [a]), /at least two findings/);
  assert.throws(() => learnPattern(root, lesson, [a, { ...a, findingId: "F9" }]), /at least two sessions/);
  assert.throws(() => learnPattern(root, lesson, [{ ...a, findingId: "F2" }, b]), /not an assessed, undisputed review finding/);
  assert.throws(() => learnPattern(root, lesson, [a, { ...b, findingId: "F7" }]), /not an assessed, undisputed review finding/);

  const entry = learnPattern(root, lesson, [a, b]);
  assert.equal(entry.kind, "lesson");
  assert.deepEqual(entry.evidence, [a, b]);
  assert.equal(entry.source, "review findings: 2 in 2 sessions");
  assert.equal(memoryStates(root).find((m) => m.id === entry.id)!.state, "candidate");
  assert.deepEqual(projectStatus(root).needsYou.filter((n) => n.text.startsWith("Lesson")).map((n) => [n.text, n.command]),
    [[`Lesson to confirm: ${lesson}`, "/waicc-memory confirm"]], "the tracker lists it under Needs you");
  assert.throws(() => learnPattern(root, "Test empty values", [a, b]), /already back lesson .* waiting for the human to confirm/);
  assert.equal(recurringFindings(root, second.id, second.requestId), null, "findings already used by a lesson are not offered again");

  assert.equal(recall(root, "Add invoice export").length, 0, "a candidate never reaches a plan");
  curate(root, entry.id, "confirm");
  assert.equal(projectStatus(root).needsYou.filter((n) => n.text.startsWith("Lesson")).length, 0);
  assert.deepEqual(recall(root, "Add invoice export").map((m) => m.id), [entry.id], "a confirmed lesson reaches every plan, whatever its words");
  curate(root, entry.id, "revoke");
  assert.throws(() => learnPattern(root, lesson, [a, b]), /already rejected a lesson from these findings/);
});

test("waicc_assess offers recurring findings, and waicc_learn_pattern proposes the lesson", async (t) => {
  const root = project(t);
  const first = reviewed(root, "Add order search", [["F1", "No test covers searching with an empty query"]]);
  const second = createSession(root, "Add customer filter");
  prepare(root, second.id, contract("Add customer filter"), "review", "Review the plan", 0);
  submitRecipientReply(root, receiveHandoff(root, second.id).pin, {
    outcome: "needs_changes", summary: "Changes needed", questions: [],
    findings: [{ id: "F1", severity: "high", description: "Missing tests for an empty filter value", evidence: "app.txt" }],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
    checks: [{ description: "Read app.txt", outcome: "passed", evidence: "Inspected" }],
  });
  const requestId = ingest(root, second.id).rounds.at(-1)!.id;

  const tools = new Map<string, any>(), notices: string[] = [];
  waicc({
    registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool), on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => false, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "learning-chat", getBranch: () => [] }, ui: { notify: (m: string) => notices.push(m) },
  } as unknown as ExtensionToolContext;
  const assessed = await tools.get("waicc_assess").execute("1", { sessionId: second.id, requestId, decision: "needs_changes", rationale: "Valid", dispositions: [] }, undefined, undefined, ctx);
  const offer = JSON.parse(assessed.content[0].text).recurringFindings;
  assert.equal(offer.earlierFindings[0].sessionId, first.id);

  const proposed = await tools.get("waicc_learn_pattern").execute("2", {
    lesson: "Plan a test for empty input on every new search or filter",
    findings: [{ sessionId: first.id, requestId: first.requestId, findingId: "F1" }, { sessionId: second.id, requestId, findingId: "F1" }],
  }, undefined, undefined, ctx);
  assert.match(JSON.parse(proposed.content[0].text).nextAction, /Never confirm it yourself/);
  assert.match(notices.at(-1)!, /^Lesson candidate from recurring review findings: Plan a test for empty input/);
});
