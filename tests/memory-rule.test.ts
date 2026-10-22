import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { learnPattern } from "../src/learning.ts";
import { auditMemory, curate, memoryStates, pendingLessons, propose, proposeDecision, recall } from "../src/memory.ts";
import { codeNames, judge, ruleContext } from "../src/memory-rule.ts";
import { loadAgentConfig } from "../src/profiles.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { assess, cancel, createSession, ingest, issue, prepare, resolveDecision } from "../src/workflow.ts";
import type { Contract, ContractDecision } from "../src/types.ts";

const code = [
  "export function codingAgent(cwd: string) {",
  "  ensure(chosen.via !== \"agy\", \"Antigravity cannot code yet\");",
  "}",
  "",
].join("\n");
const quote = "  ensure(chosen.via !== \"agy\", \"Antigravity cannot code yet\");";
const claim = "`codingAgent` refuses agy profiles, because Antigravity cannot code yet";
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";

/** A project with one source file, and a user file that turns the rule on or leaves it off. */
function project(t: TestContext, autoApprove?: boolean) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const root = join(base, "project"), agentDir = join(base, "agent");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  if (autoApprove !== undefined) writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ memory: { autoApprove } }));
  writeFileSync(join(root, "src", "profiles.ts"), code);
  writeFileSync(join(root, "app.txt"), "app");
  return { root, agentDir };
}
const state = (root: string, id: string) => memoryStates(root).find((entry) => entry.id === id)!;

test("a fact is confirmed by the rule only when it quotes its source and another session, with another model, proposes it again", (t) => {
  const { root } = project(t, true);
  assert.throws(() => propose(root, claim, "src/profiles.ts", "fact", "ensure(chosen.via === \"agy\")"), /not in src\/profiles.ts exactly as written/);
  const first = propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: A, model: "anthropic/claude-opus-5-5" });
  assert.equal(state(root, first.id).state, "candidate");
  assert.deepEqual(judge(first, ruleContext(root, [first], () => code)).points, 0);

  // The same session again counts once; the same model in another session earns half.
  assert.equal(propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: A, model: "anthropic/claude-opus-5-5" }).id, first.id);
  const again = propose(root, "codingAgent refuses agy profiles since Antigravity cannot code yet", "src/profiles.ts", "fact", quote, { sessionId: B, model: "anthropic/claude-opus-5-5" });
  assert.equal(again.id, first.id, "a similar claim about the same file supports the earlier entry");
  assert.equal(again.corroborations?.length, 1);
  assert.equal(state(root, first.id).state, "candidate");
  const [listed] = recall(root, "", true);
  assert.deepEqual([listed.rule?.points, listed.rule?.needed, listed.rule?.approved], [2, 4, false]);

  propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: C, model: "openai/gpt-6.1-sol" });
  const confirmed = state(root, first.id);
  assert.deepEqual([confirmed.state, confirmed.approvedBy], ["active", "waicc-rule"]);
  assert.equal(recall(root, "agy profiles")[0]?.id, first.id, "recalled like a confirmed entry");
  const rule = judge(confirmed, ruleContext(root, memoryStates(root), () => code));
  assert.deepEqual(rule.reasons, ["proposed again in 2 other sessions (+2)", "by different models: anthropic/claude-opus-5-5, openai/gpt-6.1-sol (+2)"]);

  // Time alone is one point: a week-old entry still quoted, proposed once, stays a candidate.
  const later = { ...ruleContext(root, [], () => code), now: Date.parse(first.createdAt) + 8 * 86_400_000 };
  const aged = judge({ ...first, corroborations: [] }, later);
  assert.deepEqual([aged.points, aged.approved, aged.reasons], [1, false, ["proposed 8 days ago and its quoted lines are still there (+1)"]]);
});

test("the rule stays off unless your user file turns it on, and only your user file can", (t) => {
  const { root } = project(t);
  const entry = propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: A, model: "a/one" });
  propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: B, model: "b/two" });
  assert.equal(state(root, entry.id).state, "candidate");
  assert.equal(recall(root, "agy").length, 0);
  assert.match(auditMemory(root).nextAction, /"memory": \{ "autoApprove": true \}/);

  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "waicc-agents.json"), JSON.stringify({ memory: { autoApprove: true } }));
  assert.throws(() => loadAgentConfig(root), /"memory" is allowed only in your user file/);
  assert.equal(state(root, entry.id).state, "candidate", "a repository cannot turn it on");
});

test("gates: no quote, a code name missing from the source, a revoked look-alike or an accepted finding keep an entry for you", (t) => {
  const { root } = project(t, true);
  const unquoted = propose(root, claim, "src/profiles.ts", "fact", undefined, { sessionId: A, model: "a/one" });
  propose(root, claim, "src/profiles.ts", "fact", undefined, { sessionId: B, model: "b/two" });
  assert.equal(state(root, unquoted.id).state, "candidate");
  assert.match(recall(root, "", true)[0].rule!.blocked[0], /quotes no lines/);

  assert.deepEqual(codeNames("`codingAgent` reads src/profiles.ts and memory_rule, not resolveDispatch."), ["codingAgent", "src/profiles.ts", "memory_rule", "resolveDispatch"]);
  const named = propose(root, "`resolveDispatch` refuses agy profiles too", "src/profiles.ts", "fact", quote, { sessionId: A, model: "a/one" });
  propose(root, "`resolveDispatch` refuses agy profiles too", "src/profiles.ts", "fact", quote, { sessionId: B, model: "b/two" });
  assert.deepEqual(judge(named, ruleContext(root, memoryStates(root), () => code)).blocked, ['"resolveDispatch" is not in src/profiles.ts']);

  // A revoked entry teaches the rule: anything like it waits for you.
  curate(root, unquoted.id, "revoke");
  const lookalike = propose(root, "codingAgent refuses agy profiles; Antigravity cannot code", "src/profiles.ts", "fact", quote, { sessionId: A, model: "a/one" });
  propose(root, "codingAgent refuses agy profiles; Antigravity cannot code", "src/profiles.ts", "fact", quote, { sessionId: B, model: "b/two" });
  assert.equal(state(root, lookalike.id).state, "candidate");
  assert.match(judge(lookalike, ruleContext(root, memoryStates(root), () => code)).blocked[0], /resembles an entry you revoked/);
  const audit = auditMemory(root);
  assert.deepEqual(audit.ruleWouldHaveConfirmed, [], "the rule would not have confirmed what you revoked");
  assert.equal(audit.youRevoked, 1);
});

test("a fact stays current while its quoted lines are there, whatever else changes in the file", (t) => {
  const { root } = project(t);
  const quoted = propose(root, claim, "src/profiles.ts", "fact", quote);
  const whole = propose(root, "The file defines codingAgent", "src/profiles.ts", "fact");
  writeFileSync(join(root, "src", "profiles.ts"), `// A new comment\r\n${code.replaceAll("\n", "\r\n")}`);
  assert.equal(state(root, quoted.id).state, "candidate", "other lines and line endings changed: still current");
  assert.equal(state(root, whole.id).state, "stale", "without a quote, any change makes it stale");
  writeFileSync(join(root, "src", "profiles.ts"), code.replace("agy", "antigravity"));
  assert.equal(state(root, quoted.id).state, "stale");
  assert.throws(() => curate(root, quoted.id, "confirm"), /source changed/);
});

const decision = (id: string, question: string): ContractDecision => ({ id, question, owner: "human", status: "open", affectedTaskIds: ["T1"],
  evidence: ["app.txt keeps everything"], recommendation: "Keep 30 days", risk: "low", reversible: true });
const scope = (title: string, decisions?: ContractDecision[]): Contract => ({
  title, requirements: [{ id: "R1", text: title, sourceQuote: title }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title, requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"],
    acceptance: [{ id: "AC1", text: "Works", requirementIds: ["R1"], verification: "Run the tests" }] }],
  ...(decisions ? { decisions } : {}),
});

test("a decision you answered with /waicc-decide is saved in WAICC's words and confirmed at once; a policy's answer is not", (t) => {
  const { root } = project(t, true);
  const s = createSession(root, "Store status messages");
  prepare(root, s.id, scope("Store status messages", [decision("D1", "How long are messages kept?"), decision("D2", "Are messages encrypted?")]), "planning", "Plan", 0);
  cancel(root, s.id);
  assert.throws(() => proposeDecision(root, s.id, "D1", { sessionId: s.id, model: null }), /not answered yet/);
  resolveDecision(root, s.id, "D1", "30 days, then deleted");
  resolveDecision(root, s.id, "d2", "Yes, at rest", { kind: "policy", policy: "Encrypt personal data at rest", rationale: "Messages are personal data" });

  const entry = proposeDecision(root, s.id, "d1", { sessionId: s.id, model: "a/one" });
  assert.equal(entry.text, "How long are messages kept? Answer: 30 days, then deleted");
  assert.deepEqual([entry.kind, entry.decision?.decisionId], ["decision", "D1"]);
  assert.equal(proposeDecision(root, s.id, "D1", { sessionId: s.id, model: "a/one" }).id, entry.id, "proposed once");
  assert.deepEqual([state(root, entry.id).state, state(root, entry.id).approvedBy], ["active", "waicc-rule"]);
  assert.throws(() => proposeDecision(root, s.id, "D2", { sessionId: s.id, model: null }), /answered by a standing policy, not by the human directly/);
});

/** A session whose review came back with one finding, assessed as a real problem. */
function reviewed(root: string, title: string, description: string) {
  const s = createSession(root, title);
  prepare(root, s.id, scope(title), "review", "Review the plan", 0);
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "needs_changes", summary: "Changes needed", questions: [],
    findings: [{ id: "F1", severity: "medium", description, evidence: "app.txt" }],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
    checks: [{ description: "Read app.txt", outcome: "passed", evidence: "Inspected" }],
  });
  const requestId = ingest(root, s.id).rounds.at(-1)!.id;
  assess(root, s.id, { requestId, decision: "needs_changes", rationale: "Valid", dispositions: [] });
  return { sessionId: s.id, requestId, findingId: "F1" };
}

test("a lesson is confirmed once findings from three sessions back it; a later session strengthens it", (t) => {
  const { root } = project(t, true);
  const one = reviewed(root, "Add order search", "No test covers searching with an empty query");
  const two = reviewed(root, "Add customer filter", "Missing tests for an empty filter value");
  const lesson = learnPattern(root, "Plan a test for empty input on every new search or filter", [one, two]);
  assert.equal(state(root, lesson.id).state, "candidate");
  assert.equal(pendingLessons(root).length, 1, "still needs you on the tracker");

  const three = reviewed(root, "Add product lookup", "No test for an empty product code");
  assert.throws(() => learnPattern(root, undefined, [one], lesson.id), /already backs lesson/);
  const stronger = learnPattern(root, undefined, [three], lesson.id);
  assert.equal(stronger.source, "review findings: 3 in 3 sessions");
  assert.deepEqual([state(root, lesson.id).state, state(root, lesson.id).approvedBy], ["active", "waicc-rule"]);
  assert.equal(pendingLessons(root).length, 0);
  assert.throws(() => learnPattern(root, undefined, [three], lesson.id), /already backs lesson/);
});

/** A session that changed src/profiles.ts, keeping the quoted lines, and passed its code review. */
function passedReview(root: string, title: string, line: string) {
  const s = createSession(root, title);
  const plan = { ...scope(title), tasks: scope(title).tasks.map((task) => ({ ...task, allowedPaths: ["src/profiles.ts"] })) };
  prepare(root, s.id, plan, "planning", "Plan", 0);
  const checks = [{ description: "Read src/profiles.ts", outcome: "passed" as const, evidence: "Inspected" }];
  const body = (outcome: string) => ({ outcome, summary: "Done", questions: [], findings: [], checks,
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "src/profiles.ts" }] });
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, body("planned"));
  assess(root, s.id, { requestId: ingest(root, s.id).rounds.at(-1)!.id, decision: "planned", rationale: "Sound plan", dispositions: [] });
  writeFileSync(join(root, "src", "profiles.ts"), `${line}\n${code}`);
  issue(root, s.id, "review", "Review the whole change", undefined, undefined,
    { kind: "code", completion: { summary: "All done", tasks: [{ taskId: "T1", evidence: "src/profiles.ts" }], checks, findings: [] } });
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, body("ready"));
  const passed = assess(root, s.id, { requestId: ingest(root, s.id).rounds.at(-1)!.id, decision: "ready", rationale: "Verified", dispositions: [] });
  assert.equal(passed.reviewApproval?.kind, "code");
}

test("later code reviews that pass with the file changed and the quote intact count for a fact", (t) => {
  const { root } = project(t, true);
  const entry = propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: A, model: "a/one" });
  propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: B, model: "a/one" });
  passedReview(root, "Add a header comment", "// Profiles");
  assert.deepEqual([recall(root, "", true)[0].rule?.points, state(root, entry.id).state], [3, "candidate"]);
  passedReview(root, "Note the licence", "// Licensed MIT");
  assert.deepEqual([state(root, entry.id).state, state(root, entry.id).approvedBy], ["active", "waicc-rule"]);
  assert.match(judge(state(root, entry.id), ruleContext(root, memoryStates(root), () => `// Licensed MIT\n${code}`)).reasons[1], /^2 later code reviews passed with src\/profiles.ts changed/);
});

test("an accepted review finding about the same thing keeps a fact for you", (t) => {
  const { root } = project(t, true);
  reviewed(root, "Antigravity support", "codingAgent still accepts agy profiles although Antigravity cannot code yet");
  const entry = propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: A, model: "a/one" });
  propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: B, model: "b/two" });
  assert.equal(state(root, entry.id).state, "candidate");
  assert.match(recall(root, "", true).find((row) => row.id === entry.id)!.rule!.blocked[0], /an accepted review finding is about the same thing/);
});

test("the audit replays the rule against what you confirmed and revoked", (t) => {
  const { root } = project(t);
  const kept = propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: A, model: "a/one" });
  propose(root, claim, "src/profiles.ts", "fact", quote, { sessionId: B, model: "b/two" });
  curate(root, kept.id, "confirm");
  const wrong = propose(root, "The file defines `codingAgent` in src/profiles.ts", "src/profiles.ts", "fact", "export function codingAgent(cwd: string) {", { sessionId: A, model: "a/one" });
  propose(root, "The file defines `codingAgent` in src/profiles.ts", "src/profiles.ts", "fact", "export function codingAgent(cwd: string) {", { sessionId: B, model: "b/two" });
  curate(root, wrong.id, "revoke");

  const audit = auditMemory(root);
  assert.deepEqual([audit.autoApprove, audit.youConfirmed, audit.ruleWouldConfirmOfThose, audit.youRevoked], ["off", 1, 1, 1]);
  assert.deepEqual(audit.ruleWouldHaveConfirmed.map((row) => row.id), [wrong.id]);
  assert.match(audit.nextAction, /would have confirmed 1 entry you revoked/);
  assert.equal(memoryStates(root).find((entry) => entry.id === kept.id)?.confirmedBy, "human");
});
