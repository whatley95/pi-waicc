import { readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Contract, Reply } from "./types.ts";

const packagedSkills = readdirSync(new URL("../skills/", import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
/** A JSON object or array sent as text, decoded; anything else is returned unchanged.
 * Some models send nested tool arguments as JSON strings and retry forever when refused. */
export function decodeJsonText(value: unknown): unknown {
  if (typeof value !== "string" || !/^s*[{[]/.test(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

/** Decodes JSON text in every top-level argument whose schema does not declare plain text. */
export function decodeJsonArguments<T>(params: T, schema: unknown): T {
  if (!params || typeof params !== "object") return params;
  const properties = (schema as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties ?? {};
  return Object.fromEntries(Object.entries(params as Record<string, unknown>).map(([key, value]) =>
    [key, properties[key]?.type === "string" ? value : decodeJsonText(value)])) as T;
}

export function record(value: unknown, name: string): Record<string, unknown> {
  ensure(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${name} must be an object`,
  );
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  allowed: string[],
  name: string,
): void {
  const unsupported = Object.keys(value).filter(
    (key) => !allowed.includes(key),
  );
  ensure(
    unsupported.length === 0,
    `${name} contains unsupported fields: ${unsupported.map((key) => JSON.stringify(key)).join(", ")}. Allowed: ${allowed.join(", ")}`,
  );
}
export function text(value: unknown, name: string, max = 32_000): string {
  ensure(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
    `${name} must be nonempty text (maximum ${max} characters)`,
  );
  return value;
}
export function list(value: unknown, name: string, max = 300): unknown[] {
  ensure(
    Array.isArray(value) && value.length <= max,
    `${name} must be an array (maximum ${max} entries)`,
  );
  return value;
}
function strings(value: unknown, name: string): string[] {
  return list(value, name).map((entry) => text(entry, name));
}
export function identifier(value: unknown, name = "ID"): string {
  const id = text(value, name, 80);
  ensure(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id),
    `${name} contains invalid characters`,
  );
  return id;
}
export function advisorInput(input: string): {
  question: string;
  requirementIds?: string[];
} {
  const value = text(input.trim(), "Advisor question");
  if (!value.startsWith("--")) return { question: value };
  const match = /^--requirements\s+(\S+)\s+([\s\S]+)$/.exec(value);
  ensure(match, "Usage: advisor [--requirements REQ-001,REQ-002] <question>");
  return {
    question: text(match[2].trim(), "Advisor question"),
    requirementIds: match[1].split(","),
  };
}
export function relativePath(value: unknown): string {
  const path = text(value, "Relative path", 1000).replaceAll("\\", "/");
  ensure(
    !isAbsolute(path) && !/^[A-Za-z]:|[:\x00-\x1f*?]/.test(path),
    `Unsafe relative path: ${path}`,
  );
  ensure(
    path
      .split("/")
      .every(
        (part) =>
          part !== ".." &&
          part !== "." &&
          part !== "" &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      ),
    `Unsafe path component: ${path}`,
  );
  ensure(
    !/^(\.git|\.svn)(\/|$)|^\.pi\/pi-waicc(\/|$)/i.test(path),
    `Reserved path: ${path}`,
  );
  return path;
}
function unique(values: string[], name: string): void {
  ensure(new Set(values).size === values.length, `Duplicate ${name}`);
}
export function validateContract(
  value: unknown,
  requirements: string,
): Contract {
  ensure(
    JSON.stringify(value)?.length <= 128_000,
    "Contract exceeds 128,000 characters",
  );
  const c = record(value, "Contract");
  keys(
    c,
    [
      "title",
      "requirements",
      "exclusions",
      "assumptions",
      "questions",
      "risks",
      "tasks",
      "skills",
      "decisions",
    ],
    "Contract",
  );
  text(c.title, "Title", 300);
  const reqs = list(c.requirements, "Requirements").map((entry) => {
    const r = record(entry, "Requirement");
    keys(r, ["id", "text", "sourceQuote"], "Requirement");
    identifier(r.id);
    text(r.text, "Requirement");
    text(r.sourceQuote, "Original requirement quote");
    ensure(
      requirements.includes(r.sourceQuote as string),
      `Requirement ${r.id} needs an exact quote from the original request or amendment`,
    );
    return r;
  });
  ensure(reqs.length > 0, "At least one requirement is required");
  const reqIds = reqs.map((r) => r.id as string);
  unique(reqIds, "requirement IDs");
  for (const field of ["exclusions", "assumptions", "questions", "risks"])
    strings(c[field], field);
  const skillNames = strings(c.skills, "Skills");
  skillNames.forEach((name) => {
    ensure(/^[a-z0-9-]+$/.test(name), "Invalid skill name");
    ensure(
      packagedSkills.includes(name),
      `Unknown skill ${name}. Available: ${packagedSkills.join(", ")}`,
    );
  });
  unique(skillNames, "skills");
  const tasks = list(c.tasks, "Tasks").map((entry) => {
    const task = record(entry, "Task");
    keys(
      task,
      [
        "id",
        "title",
        "requirementIds",
        "dependsOn",
        "allowedPaths",
        "acceptance",
      ],
      "Task",
    );
    identifier(task.id);
    text(task.title, "Task title", 500);
    const refs = strings(task.requirementIds, "Task requirements");
    unique(refs, "task requirement references");
    ensure(
      refs.length > 0 && refs.every((id) => reqIds.includes(id)),
      `Task ${task.id} references unknown or missing requirements`,
    );
    unique(strings(task.dependsOn, "Dependencies"), "dependencies");
    strings(task.allowedPaths, "Allowed paths").forEach(relativePath);
    for (const entry of list(task.acceptance, "Acceptance criteria")) {
      const ac = record(entry, "Acceptance criterion");
      keys(
        ac,
        ["id", "text", "requirementIds", "verification"],
        "Acceptance criterion",
      );
      identifier(ac.id);
      text(ac.text, "Acceptance criterion");
      text(ac.verification, "Planned verification");
      const criteriaRefs = strings(
        ac.requirementIds,
        "Acceptance requirement IDs",
      );
      unique(criteriaRefs, "acceptance requirement IDs");
      ensure(
        criteriaRefs.length > 0 &&
          criteriaRefs.every((id) => refs.includes(id)),
        "Acceptance criterion must reference its task's requirements",
      );
    }
    return task;
  });
  const ids = tasks.map((task) => task.id as string);
  unique(ids, "task IDs");
  unique(
    tasks.flatMap((task) =>
      (task.acceptance as { id: string }[]).map((ac) => ac.id),
    ),
    "acceptance IDs",
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    ensure(!visiting.has(id), `Task dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of tasks.find((task) => task.id === id)!
      .dependsOn as string[]) {
      ensure(ids.includes(dep), `Unknown dependency ${dep}`);
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };
  ids.forEach(visit);
  const decisions = list(c.decisions ?? [], "Decisions").map((entry) => {
    const d = record(entry, "Decision");
    keys(
      d,
      [
        "id",
        "question",
        "owner",
        "status",
        "affectedTaskIds",
        "evidence",
        "recommendation",
        "answer",
        "risk",
        "reversible",
      ],
      "Decision",
    );
    ensure(d.risk === undefined || ["low", "medium", "high"].includes(d.risk as string), "Decision risk must be low, medium or high");
    ensure(d.reversible === undefined || typeof d.reversible === "boolean", "Decision reversible must be true or false");
    identifier(d.id, "Decision ID");
    text(d.question, "Decision question");
    ensure(
      ["agent", "human", "external"].includes(d.owner as string),
      "Invalid decision owner",
    );
    ensure(
      ["open", "resolved", "deferred"].includes(d.status as string),
      "Invalid decision status",
    );
    const affected = strings(d.affectedTaskIds, "Affected task IDs");
    unique(affected, "affected task IDs");
    ensure(
      affected.length > 0 && affected.every((id) => ids.includes(id)),
      "A decision must name existing affected tasks",
    );
    ensure(
      strings(d.evidence, "Decision investigation evidence").length > 0,
      "Decision needs investigation evidence, including any access limit",
    );
    text(d.recommendation, "Decision recommendation");
    if (d.answer !== undefined) text(d.answer, "Decision answer");
    if (d.status === "resolved") text(d.answer, "Resolved decision answer");
    else
      ensure(
        d.answer === undefined,
        "An unresolved decision must not carry a confirmed answer",
      );
    return d.id as string;
  });
  unique(decisions, "decision IDs");
  return structuredClone(c) as unknown as Contract;
}
/** A complete specification can gate execution on documented human/external decisions. */
export function readyPlan(contract: Contract): void {
  ensure(contract.questions.length === 0, "Contract has unresolved questions");
  ensure(
    contract.tasks.length > 0 &&
      contract.tasks.every((t) => t.acceptance.length > 0),
    "Every implementation task needs acceptance criteria",
  );
  ensure(
    contract.tasks.every((t) => t.allowedPaths.length > 0),
    "Every implementation task needs explicit allowed paths",
  );
  const covered = new Set(
    contract.tasks.flatMap((t) =>
      t.acceptance.flatMap((a) => a.requirementIds),
    ),
  );
  ensure(
    contract.requirements.every((r) => covered.has(r.id)),
    "Some requirements have no acceptance criteria",
  );
  ensure(
    !(contract.decisions ?? []).some(
      (d) => d.owner === "agent" && d.status !== "resolved",
    ),
    "Investigate agent-owned decisions before accepting the plan; record genuine access limits as external decisions",
  );
}
export function readyContract(contract: Contract): void {
  readyPlan(contract);
  ensure(
    (contract.decisions ?? []).every((d) => d.status === "resolved"),
    "Execution is gated by unresolved contract decisions; plan acceptance is not implementation authorization",
  );
}
export function validateReply(value: unknown): Reply {
  const r = record(value, "Reply");
  keys(
    r,
    [
      "schemaVersion",
      "sessionId",
      "requestId",
      "contractVersion",
      "requirementsDigest",
      "sourceFingerprint",
      "mode",
      "outcome",
      "summary",
      "coverage",
      "findings",
      "questions",
      "checks",
      "proposedContract",
      "completion",
      "advice",
    ],
    "Reply",
  );
  ensure(r.schemaVersion === 1, "Unsupported reply schemaVersion");
  identifier(r.sessionId);
  identifier(r.requestId);
  ensure(
    Number.isSafeInteger(r.contractVersion) && Number(r.contractVersion) > 0,
    "Invalid contract version",
  );
  for (const field of ["requirementsDigest", "sourceFingerprint"])
    ensure(
      typeof r[field] === "string" && /^[a-f0-9]{64}$/.test(r[field]),
      `Invalid ${field}`,
    );
  ensure(
    ["planning", "review", "implementation", "testing", "advisor"].includes(
      r.mode as string,
    ),
    "Invalid reply mode",
  );
  ensure(
    [
      "ready",
      "planned",
      "needs_changes",
      "needs_clarification",
      "blocked",
    ].includes(r.outcome as string),
    "Invalid reply outcome",
  );
  ensure(
    r.outcome !== "planned" || r.mode === "planning",
    "The planned outcome is only valid for planning",
  );
  text(r.summary, "Reply summary");
  if (r.completion !== undefined) {
    ensure(r.mode === "implementation", "Only implementation replies supply a work completion report");
    record(r.completion, "Work completion report");
  }
  if (r.mode === "testing")
    ensure(r.proposedContract === undefined, "Testing reports findings, not replacement contracts");
  strings(r.questions, "Questions");
  const coverage = list(r.coverage, "Coverage").map((entry) => {
    const row = record(entry, "Coverage");
    keys(row, ["requirementId", "status", "evidence"], "Coverage");
    identifier(row.requirementId);
    text(row.evidence, "Coverage evidence");
    ensure(
      ["addressed", "missing", "unverified"].includes(row.status as string),
      "Invalid coverage status",
    );
    return row.requirementId as string;
  });
  unique(coverage, "coverage IDs");
  const findings = list(r.findings, "Findings").map((entry) => {
    const f = record(entry, "Finding");
    keys(
      f,
      ["id", "severity", "description", "evidence", "suggestedFix", "extensions"],
      "Finding",
    );
    identifier(f.id);
    text(f.description, "Finding description");
    text(f.evidence, "Finding evidence");
    if (f.suggestedFix !== undefined) text(f.suggestedFix, "Suggested fix");
    if (f.extensions !== undefined) record(f.extensions, "Finding extensions");
    ensure(
      ["critical", "high", "medium", "low", "info"].includes(
        f.severity as string,
      ),
      "Invalid finding severity",
    );
    return f.id as string;
  });
  unique(findings, "finding IDs");
  for (const [i, entry] of list(r.checks, "Checks").entries()) {
    const check = record(entry, "Check");
    keys(check, ["description", "outcome", "evidence", "extensions"], "Check");
    text(check.description, "Check description");
    text(check.evidence, "Check evidence");
    if (check.extensions !== undefined)
      record(check.extensions, "Check extensions");
    ensure(
      ["passed", "failed", "not_run"].includes(check.outcome as string),
      `Invalid check outcome at checks[${i}].outcome: expected passed, failed or not_run; received ${JSON.stringify(check.outcome)?.slice(0, 120) ?? "undefined"}`,
    );
  }
  if (r.mode === "advisor") {
    ensure(
      r.proposedContract === undefined,
      "Advisor replies suggest amendments, not replacement contracts",
    );
    const advice = record(r.advice, "Advisor advice");
    keys(
      advice,
      [
        "question",
        "options",
        "recommendation",
        "assumptions",
        "proposedAmendments",
      ],
      "Advisor advice",
    );
    text(advice.question, "Advisor question");
    strings(advice.assumptions, "Advisor assumptions");
    strings(advice.proposedAmendments, "Proposed amendments");
    const options = list(advice.options, "Advisor options").map((entry) => {
      const option = record(entry, "Advisor option");
      keys(
        option,
        ["id", "title", "benefits", "tradeoffs", "evidence"],
        "Advisor option",
      );
      identifier(option.id);
      text(option.title, "Option title");
      const benefits = strings(option.benefits, "Option benefits");
      const tradeoffs = strings(option.tradeoffs, "Option tradeoffs");
      const evidence = strings(option.evidence, "Option evidence");
      if (r.outcome === "ready")
        ensure(
          benefits.length > 0 && tradeoffs.length > 0 && evidence.length > 0,
          "Completed advice needs benefits, tradeoffs and evidence for each option",
        );
      return option.id as string;
    });
    unique(options, "advisor option IDs");
    if (advice.recommendation !== null) {
      const recommendation = record(
        advice.recommendation,
        "Advisor recommendation",
      );
      keys(recommendation, ["optionId", "rationale"], "Advisor recommendation");
      ensure(
        options.includes(recommendation.optionId as string),
        "Recommendation must reference a supplied option",
      );
      text(recommendation.rationale, "Recommendation rationale");
    }
    if (r.outcome === "ready")
      ensure(
        options.length >= 2 && advice.recommendation !== null,
        "Completed advice needs at least two options and a recommendation",
      );
  } else
    ensure(r.advice === undefined, "Advice is only valid for advisor replies");
  return structuredClone(r) as unknown as Reply;
}
