import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeReply } from "../src/reply.ts";
import { validateContract, validateReply } from "../src/validation.ts";

function reply(findings: unknown[] = []) {
  return {
    schemaVersion: 1,
    sessionId: "session",
    requestId: "request",
    contractVersion: 1,
    requirementsDigest: "a".repeat(64),
    sourceFingerprint: "b".repeat(64),
    mode: "planning",
    outcome: "needs_clarification",
    summary: "Source inspection, not delivery verification.",
    coverage: [
      {
        requirementId: "REQ-001",
        status: "unverified",
        evidence: "Not independently verified",
      },
    ],
    findings,
    questions: ["Owner decision needed"],
    checks: [
      { description: "Run tests", outcome: "not_run", evidence: "Not run" },
    ],
  };
}
function finding() {
  return {
    id: "F-001",
    severity: "high",
    description: "An acceptance criterion is missing",
    evidence: "REQ-001 has no negative case",
  };
}

test("canonical replies are unchanged and compatibility is deterministic, idempotent and non-mutating", () => {
  const input = reply([finding()]),
    before = structuredClone(input);
  const normalized = normalizeReply(input);
  assert.deepEqual(normalized.reply, input);
  assert.deepEqual(normalized.changes, []);
  assert.deepEqual(input, before);
  assert.deepEqual(normalizeReply(normalized.reply), normalized);
  assert.deepEqual(validateReply(normalized.reply).findings, [finding()]);
});

test("the five-title external-agent format gets stable IDs and descriptions without changing claims", () => {
  const findings = Array.from({ length: 5 }, (_, i) => ({
    severity: i < 2 ? "medium" : "low",
    title: `Concern ${i + 1}`,
    evidence: `Source evidence ${i + 1}`,
  }));
  const input = reply(findings),
    before = structuredClone(input);
  const first = normalizeReply(input);
  const parsed = validateReply(first.reply);
  assert.deepEqual(
    parsed.findings.map((f) => f.id),
    ["F-001", "F-002", "F-003", "F-004", "F-005"],
  );
  assert.deepEqual(
    parsed.findings.map((f) => f.description),
    findings.map((f) => f.title),
  );
  assert.deepEqual(
    parsed.findings.map((f) => f.severity),
    findings.map((f) => f.severity),
  );
  assert.deepEqual(
    parsed.findings.map((f) => f.evidence),
    findings.map((f) => f.evidence),
  );
  assert.equal(first.changes.length, 10);
  assert.deepEqual(normalizeReply(input), first);
  assert.deepEqual(normalizeReply(first.reply).changes, []);
  assert.deepEqual(input, before);
  assert.equal(parsed.outcome, "needs_clarification");
  assert.equal(parsed.coverage[0].status, "unverified");
  assert.equal(parsed.checks[0].outcome, "not_run");
  assert.deepEqual(parsed.questions, before.questions);
  for (const key of [
    "sessionId",
    "requestId",
    "contractVersion",
    "requirementsDigest",
    "sourceFingerprint",
    "mode",
  ] as const)
    assert.equal(parsed[key], input[key]);
});

test("aliases, casing, text-array evidence and annotations produce readable canonical findings", () => {
  const input = reply([
    {
      findingId: "agent-42",
      severity: " HIGH ",
      message: "Review concern",
      evidence: ["File:12", "REQ-001 lacks coverage"],
      file: "src/example.ts",
      line: 12,
      recommendation: "Add the missing test",
      extensions: { agent: { name: "reviewer" } },
    },
  ]);
  const normalized = normalizeReply(input);
  assert.deepEqual(validateReply(normalized.reply).findings, [
    {
      id: "agent-42",
      severity: "high",
      description: "Review concern",
      evidence: "File:12\nREQ-001 lacks coverage",
      extensions: {
        agent: { name: "reviewer" },
        file: "src/example.ts",
        line: 12,
        recommendation: "Add the missing test",
      },
    },
  ]);
  assert.deepEqual(normalizeReply(normalized.reply).changes, []);
});

test("generated finding IDs avoid all supplied IDs, including later entries and aliases", () => {
  const base = { severity: "info", title: "Concern", evidence: "Source" };
  const parsed = validateReply(
    normalizeReply(
      reply([
        base,
        { ...base, id: "F-001" },
        { ...base, findingId: "F-002" },
        base,
      ]),
    ).reply,
  );
  assert.deepEqual(
    parsed.findings.map((f) => f.id),
    ["F-003", "F-001", "F-002", "F-004"],
  );
  assert.throws(
    () => validateReply(normalizeReply(reply([finding(), finding()])).reply),
    /Duplicate finding IDs/,
  );
  assert.throws(
    () => normalizeReply(reply([{ ...finding(), findingId: "different" }])),
    /id and findingId disagree/,
  );
});

test("description takes precedence while a distinct title/message remains visible as annotations", () => {
  const parsed = validateReply(
    normalizeReply(
      reply([
        {
          ...finding(),
          title: "Short heading",
          message: "Additional explanation",
        },
      ]),
    ).reply,
  );
  assert.equal(parsed.findings[0].description, finding().description);
  assert.deepEqual(parsed.findings[0].extensions, {
    title: "Short heading",
    message: "Additional explanation",
  });
  assert.throws(
    () =>
      normalizeReply(
        reply([{ ...finding(), file: "a", extensions: { file: "b" } }]),
      ),
    /conflicts with extensions/,
  );
});

test("flexible findings do not invent missing severity/evidence/description or reinterpret statuses", () => {
  const invalid = [
    { title: "Concern", evidence: "Source" },
    { severity: "high", title: "Concern" },
    { severity: "high", evidence: "Source" },
    { ...finding(), severity: "urgent" },
    { ...finding(), severity: "P1" },
    { ...finding(), evidence: [] },
    { ...finding(), evidence: [{ file: "source" }] },
    { ...finding(), extensions: null },
    { ...finding(), id: null },
    "A free-form concern without structured evidence",
  ];
  for (const f of invalid)
    assert.throws(() => validateReply(normalizeReply(reply([f])).reply));
  assert.throws(
    () =>
      validateReply(
        normalizeReply({ ...reply(), command: "execute something" }).reply,
      ),
    /unsupported fields.*command/,
  );
  assert.throws(
    () => validateReply(normalizeReply({ ...reply(), outcome: "PASS" }).reply),
    /Invalid reply outcome/,
  );
  assert.throws(
    () =>
      validateReply(
        normalizeReply({
          ...reply(),
          checks: [{ description: "Test", status: "pass" }],
        }).reply,
      ),
    /Check evidence must be nonempty/,
  );
});

test("annotations are untrusted JSON data, including command-like and prototype-named keys", () => {
  const input = reply([
    JSON.parse(
      '{"severity":"info","title":"Concern","evidence":"Source","command":"do not execute","__proto__":{"polluted":true}}',
    ),
  ]);
  const parsed = validateReply(normalizeReply(input).reply);
  assert.equal(parsed.findings[0].extensions!.command, "do not execute");
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(parsed.findings[0].extensions, "__proto__")
      ?.value,
    { polluted: true },
  );
  assert.equal(Object.hasOwn({}, "polluted"), false);
});

test("canonical validator stays strict; only the reply transport normalizer accepts aliases", () => {
  assert.throws(
    () =>
      validateReply(
        reply([{ severity: "medium", title: "Concern", evidence: "Source" }]),
      ),
    /unsupported fields.*title.*Allowed:/,
  );
  assert.throws(
    () => validateReply({ ...reply(), checks: [{ description: "Inspect", outcome: "pass", evidence: "Source" }] }),
    /Invalid check outcome at checks\[0\].outcome/,
  );
});

test("check outcome synonyms preserve pass, failure and not-run meanings without mutating inputs", () => {
  for (const [input, expected] of [
    ["pass", "passed"], [" PASS ", "passed"], ["success", "passed"],
    ["Succeeded", "passed"], ["passed", "passed"], ["fail", "failed"],
    ["FAILURE", "failed"], ["failed", "failed"], ["not run", "not_run"],
    ["NOT-RUN", "not_run"], ["not_executed", "not_run"],
    ["not attempted", "not_run"], ["skipped", "not_run"], ["not_run", "not_run"],
  ]) {
    const original = { ...reply(), checks: [{ description: "Inspect", outcome: input, evidence: "Actual limits" }] };
    const before = structuredClone(original), normalized = normalizeReply(original);
    const parsed = validateReply(normalized.reply);
    assert.equal(parsed.checks[0].outcome, expected);
    assert.equal(parsed.checks[0].evidence, "Actual limits");
    assert.equal(parsed.outcome, original.outcome);
    assert.deepEqual(parsed.coverage, original.coverage);
    assert.deepEqual(original, before);
    assert.deepEqual(normalizeReply(normalized.reply).changes, []);
    assert.equal(normalized.changes.length, input === expected ? 0 : 1);
  }
});

test("check field aliases and annotations are readable while preserving evidence and provenance", () => {
  const input = { ...reply(), checks: [{
    name: "Source inspection", status: "pass", output: ["file.ts:10", "Inspection only"],
    command: "do not execute this annotation", exitCode: 0,
  }] };
  const normalized = normalizeReply(input), parsed = validateReply(normalized.reply);
  assert.deepEqual(parsed.checks, [{
    description: "Source inspection", outcome: "passed", evidence: "file.ts:10\nInspection only",
    extensions: { command: "do not execute this annotation", exitCode: 0 },
  }]);
  assert.ok(normalized.changes.length >= 4);
  assert.deepEqual(normalizeReply(normalized.reply).changes, []);
  const equivalent = normalizeReply({ ...reply(), checks: [{
    check: "Run tests", outcome: "failed", status: "FAIL", result: "failure", details: "Assertion failed",
  }] });
  assert.equal(validateReply(equivalent.reply).checks[0].outcome, "failed");
});

test("conflicting results and extension collisions are rejected instead of hiding a failure", () => {
  for (const check of [
    { outcome: "passed", status: "failed" },
    { outcome: "not_run", result: "pass" },
    { status: "success", result: "fail" },
    { outcome: "failed", exitCode: 1, extensions: { exitCode: 0 } },
  ]) assert.throws(() => normalizeReply({
    ...reply(), checks: [{ description: "Tests", evidence: "Actual output", ...check }],
  }), /disagree|conflicts with extensions/);
});

test("unknown, ambiguous or missing check data is never converted into a pass or default not_run", () => {
  for (const value of ["unknown", "pending", "blocked", "error", "partial", "inconclusive", true, 0, null, undefined]) {
    assert.throws(() => validateReply(normalizeReply({
      ...reply(), checks: [{ description: "Check", outcome: value, evidence: "Evidence" }],
    }).reply), /Invalid check outcome at checks\[0\].outcome/);
  }
  for (const check of [
    { outcome: "pass", evidence: "Source" },
    { description: "Inspect", status: "pass" },
    { description: "Inspect", result: "pass", output: [] },
    { description: "Inspect", outcome: "pass", evidence: ["text", { file: "source" }] },
    { description: "Inspect", outcome: "pass", evidence: false },
  ]) assert.throws(() => validateReply(normalizeReply({ ...reply(), checks: [check] }).reply));
});

function proposal(evidence: unknown = ["Source and access limit"]) {
  return {
    title: "Search", requirements: [{ id: "REQ-001", text: "Add search", sourceQuote: "Add search" }],
    exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
    tasks: [{ id: "T1", title: "Search", requirementIds: ["REQ-001"], dependsOn: [], allowedPaths: ["source.ts"], acceptance: [] }],
    decisions: [{ id: "D1", question: "Which presentation?", owner: "human", status: "open",
      affectedTaskIds: ["T1"], evidence, recommendation: "Keep existing presentation until chosen" }],
  };
}

test("proposed decision evidence text becomes one evidence item without inventing an answer or changing task gates", () => {
  const original = { ...reply(), proposedContract: proposal("Source; access limit\nSecond line") };
  original.proposedContract.decisions[0].owner = " HUMAN ";
  original.proposedContract.decisions[0].status = "OPEN";
  const before = structuredClone(original), normalized = normalizeReply(original);
  const parsed = validateContract(normalized.reply.proposedContract, "Add search");
  assert.deepEqual(parsed.decisions![0].evidence, ["Source; access limit\nSecond line"]);
  assert.equal(parsed.decisions![0].status, "open");
  assert.equal(parsed.decisions![0].owner, "human");
  assert.equal(parsed.decisions![0].answer, undefined);
  assert.deepEqual(parsed.decisions![0].affectedTaskIds, ["T1"]);
  assert.deepEqual(original, before);
  assert.deepEqual(normalizeReply(normalized.reply).changes, []);
  assert.throws(() => validateContract(before.proposedContract, "Add search"));
});

test("malformed decisions, unknown owners/statuses and unresolved confirmed answers stay invalid", () => {
  for (const evidence of ["", " ", [], ["text", 4], { text: "Source" }, null, undefined]) {
    assert.throws(() => {
      const contract = proposal();
      contract.decisions[0].evidence = evidence;
      const normalized = normalizeReply({ ...reply(), proposedContract: contract });
      validateContract(normalized.reply.proposedContract, "Add search");
    });
  }
  for (const patch of [
    { status: "approved" }, { owner: "reviewer" }, { status: "resolved" },
    { answer: "Pretend the owner approved it" }, { affectedTaskIds: ["unknown"] },
  ]) assert.throws(() => {
    const contract = proposal();
    Object.assign(contract.decisions[0], patch);
    validateContract(normalizeReply({ ...reply(), proposedContract: contract }).reply.proposedContract, "Add search");
  });
});

test("case/separator normalization preserves canonical reply meaning and never promotes coverage or top-level PASS", () => {
  const normalized = normalizeReply({
    ...reply(), outcome: " Needs-Clarification ",
    coverage: [{ requirementId: "REQ-001", status: " UNVERIFIED ", evidence: ["Not run", "Inspection insufficient"] }],
  });
  const parsed = validateReply(normalized.reply);
  assert.equal(parsed.outcome, "needs_clarification");
  assert.equal(parsed.coverage[0].status, "unverified");
  assert.equal(parsed.coverage[0].evidence, "Not run\nInspection insufficient");
  assert.deepEqual(parsed.questions, reply().questions);
  for (const outcome of ["PASS", "success", "approved", "completed"])
    assert.throws(() => validateReply(normalizeReply({ ...reply(), outcome }).reply), /Invalid reply outcome/);
  for (const status of ["verified", "covered", "passed"])
    assert.throws(() => validateReply(normalizeReply({ ...reply(), coverage: [{ ...reply().coverage[0], status }] }).reply), /Invalid coverage status/);
});

test("check annotations with prototype-named fields remain inert JSON data", () => {
  const check = JSON.parse('{"description":"Inspect","outcome":"pass","evidence":"Source","__proto__":{"polluted":true}}');
  const parsed = validateReply(normalizeReply({ ...reply(), checks: [check] }).reply);
  assert.deepEqual(Object.getOwnPropertyDescriptor(parsed.checks[0].extensions, "__proto__")?.value, { polluted: true });
  assert.equal(Object.hasOwn({}, "polluted"), false);
});
