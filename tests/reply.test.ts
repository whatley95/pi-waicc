import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeReply } from "../src/reply.ts";
import { validateReply } from "../src/validation.ts";

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
    /unsupported fields/,
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
});
