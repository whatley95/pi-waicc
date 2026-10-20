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

/** One problem, and where it is, such as `tasks[0].acceptance[1].verification`. */
export interface Problem { at: string; message: string }
const joinAt = (outer: string, inner: string): string =>
  !outer ? inner : !inner ? outer : inner.startsWith("[") ? `${outer}${inner}` : `${outer}.${inner}`;
/** Every independent problem in a draft at once, so an agent fixes them all in one pass. */
export class Problems extends Error {
  readonly problems: Problem[];
  constructor(problems: Problem[], suffix = "") {
    const line = (p: Problem) => (p.at ? `${p.at}: ${p.message}` : p.message);
    super(`${problems.length === 1 ? line(problems[0]) : `${problems.length} problems; fix all of them:\n${problems.map((p, i) => `${i + 1}. ${line(p)}`).join("\n")}`}${suffix}`);
    this.problems = problems;
  }
}
export function problemsOf(error: unknown, at = ""): Problem[] {
  if (error instanceof Problems) return error.problems.map((p) => ({ at: joinAt(at, p.at), message: p.message }));
  return [{ at, message: error instanceof Error ? error.message : String(error) }];
}
/**
 * Runs independent checks, keeping each failure with its location. A check that later ones
 * depend on returns undefined when it fails, so they are skipped rather than piling on.
 */
export class Collector {
  readonly problems: Problem[] = [];
  check<T>(at: string, run: () => T): T | undefined {
    try {
      return run();
    } catch (error) {
      this.problems.push(...problemsOf(error, at));
      return undefined;
    }
  }
  done(suffix = ""): void {
    if (this.problems.length) throw new Problems(this.problems, suffix);
  }
}
const idOf = (entry: unknown): string | null => {
  const id = (entry as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
};
const each = (v: Collector, value: unknown, at: string, name: string, max?: number): unknown[] => v.check(at, () => list(value, name, max)) ?? [];

export function validateContract(
  value: unknown,
  requirements: string,
): Contract {
  ensure(
    JSON.stringify(value)?.length <= 128_000,
    "Contract exceeds 128,000 characters",
  );
  const c = record(value, "Contract");
  const v = new Collector();
  v.check("", () => keys(
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
  ));
  v.check("title", () => text(c.title, "Title", 300));
  const reqs = each(v, c.requirements, "requirements", "Requirements");
  reqs.forEach((entry, i) => v.check(`requirements[${i}]`, () => {
    const r = record(entry, "Requirement");
    const w = new Collector();
    w.check("", () => keys(r, ["id", "text", "sourceQuote"], "Requirement"));
    w.check("id", () => identifier(r.id));
    w.check("text", () => text(r.text, "Requirement"));
    w.check("sourceQuote", () => {
      text(r.sourceQuote, "Original requirement quote");
      ensure(
        requirements.includes(r.sourceQuote as string),
        `Requirement ${r.id} needs an exact quote from the original request or amendment`,
      );
    });
    w.done();
  }));
  if (Array.isArray(c.requirements))
    v.check("requirements", () => ensure(reqs.length > 0, "At least one requirement is required"));
  const reqIds = reqs.map(idOf).filter((id): id is string => id !== null);
  v.check("requirements", () => unique(reqIds, "requirement IDs"));
  for (const field of ["exclusions", "assumptions", "questions", "risks"])
    v.check(field, () => strings(c[field], field));
  v.check("skills", () => {
    const skillNames = strings(c.skills, "Skills");
    skillNames.forEach((name) => {
      ensure(/^[a-z0-9-]+$/.test(name), "Invalid skill name");
      ensure(
        packagedSkills.includes(name),
        `Unknown skill ${name}. Available: ${packagedSkills.join(", ")}`,
      );
    });
    unique(skillNames, "skills");
  });
  const before = v.problems.length;
  const tasks = each(v, c.tasks, "tasks", "Tasks");
  tasks.forEach((entry, i) => v.check(`tasks[${i}]`, () => {
    const task = record(entry, "Task");
    const w = new Collector();
    w.check("", () => keys(
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
    ));
    w.check("id", () => identifier(task.id));
    w.check("title", () => text(task.title, "Task title", 500));
    const refs = w.check("requirementIds", () => {
      const refs = strings(task.requirementIds, "Task requirements");
      unique(refs, "task requirement references");
      ensure(
        refs.length > 0 && refs.every((id) => reqIds.includes(id)),
        `Task ${task.id} references unknown or missing requirements`,
      );
      return refs;
    });
    w.check("dependsOn", () => unique(strings(task.dependsOn, "Dependencies"), "dependencies"));
    const paths = w.check("allowedPaths", () => strings(task.allowedPaths, "Allowed paths")) ?? [];
    paths.forEach((path, j) => w.check(`allowedPaths[${j}]`, () => relativePath(path)));
    each(w, task.acceptance, "acceptance", "Acceptance criteria").forEach((entry, j) => w.check(`acceptance[${j}]`, () => {
      const ac = record(entry, "Acceptance criterion");
      const x = new Collector();
      x.check("", () => keys(
        ac,
        ["id", "text", "requirementIds", "verification"],
        "Acceptance criterion",
      ));
      x.check("id", () => identifier(ac.id));
      x.check("text", () => text(ac.text, "Acceptance criterion"));
      x.check("verification", () => text(ac.verification, "Planned verification"));
      x.check("requirementIds", () => {
        const criteriaRefs = strings(
          ac.requirementIds,
          "Acceptance requirement IDs",
        );
        unique(criteriaRefs, "acceptance requirement IDs");
        // Only judged against the task's own references once those are valid.
        if (refs)
          ensure(
            criteriaRefs.length > 0 &&
              criteriaRefs.every((id) => refs.includes(id)),
            "Acceptance criterion must reference its task's requirements",
          );
      });
      x.done();
    }));
    w.done();
  }));
  const ids = tasks.map(idOf).filter((id): id is string => id !== null);
  v.check("tasks", () => unique(ids, "task IDs"));
  v.check("tasks", () => unique(
    tasks.flatMap((task) => {
      const acceptance = (task as { acceptance?: unknown } | null)?.acceptance;
      return Array.isArray(acceptance) ? acceptance.map(idOf).filter((id): id is string => id !== null) : [];
    }),
    "acceptance IDs",
  ));
  // Dependencies are followed only through tasks that are themselves valid.
  if (v.problems.length === before)
    v.check("tasks", () => {
      const valid = tasks as { id: string; dependsOn: string[] }[];
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (id: string): void => {
        ensure(!visiting.has(id), `Task dependency cycle at ${id}`);
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dep of valid.find((task) => task.id === id)!.dependsOn) {
          ensure(ids.includes(dep), `Unknown dependency ${dep}`);
          visit(dep);
        }
        visiting.delete(id);
        visited.add(id);
      };
      ids.forEach(visit);
    });
  const decisions = each(v, c.decisions ?? [], "decisions", "Decisions");
  decisions.forEach((entry, i) => v.check(`decisions[${i}]`, () => {
    const d = record(entry, "Decision");
    const w = new Collector();
    w.check("", () => keys(
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
    ));
    w.check("risk", () => ensure(d.risk === undefined || ["low", "medium", "high"].includes(d.risk as string), "Decision risk must be low, medium or high"));
    w.check("reversible", () => ensure(d.reversible === undefined || typeof d.reversible === "boolean", "Decision reversible must be true or false"));
    w.check("id", () => identifier(d.id, "Decision ID"));
    w.check("question", () => text(d.question, "Decision question"));
    w.check("owner", () => ensure(
      ["agent", "human", "external"].includes(d.owner as string),
      "Invalid decision owner",
    ));
    w.check("status", () => ensure(
      ["open", "resolved", "deferred"].includes(d.status as string),
      "Invalid decision status",
    ));
    w.check("affectedTaskIds", () => {
      const affected = strings(d.affectedTaskIds, "Affected task IDs");
      unique(affected, "affected task IDs");
      ensure(
        affected.length > 0 && affected.every((id) => ids.includes(id)),
        "A decision must name existing affected tasks",
      );
    });
    w.check("evidence", () => ensure(
      strings(d.evidence, "Decision investigation evidence").length > 0,
      "Decision needs investigation evidence, including any access limit",
    ));
    w.check("recommendation", () => text(d.recommendation, "Decision recommendation"));
    w.check("answer", () => {
      if (d.answer !== undefined) text(d.answer, "Decision answer");
      if (d.status === "resolved") text(d.answer, "Resolved decision answer");
      else
        ensure(
          d.answer === undefined,
          "An unresolved decision must not carry a confirmed answer",
        );
    });
    w.done();
  }));
  v.check("decisions", () => unique(decisions.map(idOf).filter((id): id is string => id !== null), "decision IDs"));
  v.done();
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
  const v = new Collector();
  v.check("", () => keys(
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
  ));
  v.check("schemaVersion", () => ensure(r.schemaVersion === 1, "Unsupported reply schemaVersion"));
  v.check("sessionId", () => identifier(r.sessionId));
  v.check("requestId", () => identifier(r.requestId));
  v.check("contractVersion", () => ensure(
    Number.isSafeInteger(r.contractVersion) && Number(r.contractVersion) > 0,
    "Invalid contract version",
  ));
  for (const field of ["requirementsDigest", "sourceFingerprint"])
    v.check(field, () => ensure(
      typeof r[field] === "string" && /^[a-f0-9]{64}$/.test(r[field]),
      `Invalid ${field}`,
    ));
  v.check("mode", () => ensure(
    ["planning", "review", "implementation", "testing", "advisor"].includes(
      r.mode as string,
    ),
    "Invalid reply mode",
  ));
  v.check("outcome", () => {
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
  });
  v.check("summary", () => text(r.summary, "Reply summary"));
  if (r.completion !== undefined)
    v.check("completion", () => {
      ensure(r.mode === "implementation", "Only implementation replies supply a work completion report");
      record(r.completion, "Work completion report");
    });
  if (r.mode === "testing")
    v.check("proposedContract", () => ensure(r.proposedContract === undefined, "Testing reports findings, not replacement contracts"));
  v.check("questions", () => strings(r.questions, "Questions"));
  const coverage = each(v, r.coverage, "coverage", "Coverage").map((entry, i) => v.check(`coverage[${i}]`, () => {
    const row = record(entry, "Coverage");
    const w = new Collector();
    w.check("", () => keys(row, ["requirementId", "status", "evidence"], "Coverage"));
    w.check("requirementId", () => identifier(row.requirementId));
    w.check("evidence", () => text(row.evidence, "Coverage evidence"));
    w.check("status", () => ensure(
      ["addressed", "missing", "unverified"].includes(row.status as string),
      "Invalid coverage status",
    ));
    w.done();
    return row.requirementId as string;
  }));
  v.check("coverage", () => unique(coverage.filter((id): id is string => id !== undefined), "coverage IDs"));
  const findings = each(v, r.findings, "findings", "Findings").map((entry, i) => v.check(`findings[${i}]`, () => {
    const f = record(entry, "Finding");
    const w = new Collector();
    w.check("", () => keys(
      f,
      ["id", "severity", "description", "evidence", "suggestedFix", "extensions"],
      "Finding",
    ));
    w.check("id", () => identifier(f.id));
    w.check("description", () => text(f.description, "Finding description"));
    w.check("evidence", () => text(f.evidence, "Finding evidence"));
    if (f.suggestedFix !== undefined) w.check("suggestedFix", () => text(f.suggestedFix, "Suggested fix"));
    if (f.extensions !== undefined) w.check("extensions", () => record(f.extensions, "Finding extensions"));
    w.check("severity", () => ensure(
      ["critical", "high", "medium", "low", "info"].includes(
        f.severity as string,
      ),
      "Invalid finding severity",
    ));
    w.done();
    return f.id as string;
  }));
  v.check("findings", () => unique(findings.filter((id): id is string => id !== undefined), "finding IDs"));
  each(v, r.checks, "checks", "Checks").forEach((entry, i) => v.check(`checks[${i}]`, () => {
    const check = record(entry, "Check");
    const w = new Collector();
    w.check("", () => keys(check, ["description", "outcome", "evidence", "extensions"], "Check"));
    w.check("description", () => text(check.description, "Check description"));
    w.check("evidence", () => text(check.evidence, "Check evidence"));
    if (check.extensions !== undefined)
      w.check("extensions", () => record(check.extensions, "Check extensions"));
    w.check("", () => ensure(
      ["passed", "failed", "not_run"].includes(check.outcome as string),
      `Invalid check outcome at checks[${i}].outcome: expected passed, failed or not_run; received ${JSON.stringify(check.outcome)?.slice(0, 120) ?? "undefined"}`,
    ));
    w.done();
  }));
  if (r.mode === "advisor") {
    v.check("proposedContract", () => ensure(
      r.proposedContract === undefined,
      "Advisor replies suggest amendments, not replacement contracts",
    ));
    v.check("advice", () => {
      const advice = record(r.advice, "Advisor advice");
      const w = new Collector();
      w.check("", () => keys(
        advice,
        [
          "question",
          "options",
          "recommendation",
          "assumptions",
          "proposedAmendments",
        ],
        "Advisor advice",
      ));
      w.check("question", () => text(advice.question, "Advisor question"));
      w.check("assumptions", () => strings(advice.assumptions, "Advisor assumptions"));
      w.check("proposedAmendments", () => strings(advice.proposedAmendments, "Proposed amendments"));
      const options = each(w, advice.options, "options", "Advisor options").map((entry, i) => w.check(`options[${i}]`, () => {
        const option = record(entry, "Advisor option");
        const x = new Collector();
        x.check("", () => keys(
          option,
          ["id", "title", "benefits", "tradeoffs", "evidence"],
          "Advisor option",
        ));
        x.check("id", () => identifier(option.id));
        x.check("title", () => text(option.title, "Option title"));
        const benefits = x.check("benefits", () => strings(option.benefits, "Option benefits"));
        const tradeoffs = x.check("tradeoffs", () => strings(option.tradeoffs, "Option tradeoffs"));
        const evidence = x.check("evidence", () => strings(option.evidence, "Option evidence"));
        if (r.outcome === "ready" && benefits && tradeoffs && evidence)
          x.check("", () => ensure(
            benefits.length > 0 && tradeoffs.length > 0 && evidence.length > 0,
            "Completed advice needs benefits, tradeoffs and evidence for each option",
          ));
        x.done();
        return option.id as string;
      }));
      const ids = options.filter((id): id is string => id !== undefined);
      w.check("options", () => unique(ids, "advisor option IDs"));
      if (advice.recommendation !== null)
        w.check("recommendation", () => {
          const recommendation = record(
            advice.recommendation,
            "Advisor recommendation",
          );
          keys(recommendation, ["optionId", "rationale"], "Advisor recommendation");
          ensure(
            ids.includes(recommendation.optionId as string),
            "Recommendation must reference a supplied option",
          );
          text(recommendation.rationale, "Recommendation rationale");
        });
      if (r.outcome === "ready")
        w.check("", () => ensure(
          options.length >= 2 && advice.recommendation !== null,
          "Completed advice needs at least two options and a recommendation",
        ));
      w.done();
    });
  } else
    v.check("advice", () => ensure(r.advice === undefined, "Advice is only valid for advisor replies"));
  v.done();
  return structuredClone(r) as unknown as Reply;
}
