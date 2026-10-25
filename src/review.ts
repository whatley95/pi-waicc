import type {
  Contract,
  Round,
  Session,
  SourceSnapshot,
  WorkCompletion,
} from "./types.ts";
import {
  ensure,
  identifier,
  list,
  readyContract,
  record,
  text,
} from "./validation.ts";

function supported(value: Record<string, unknown>, fields: string[]): void {
  ensure(
    Object.keys(value).every((key) => fields.includes(key)),
    "Unsupported completion report fields",
  );
}

export interface ReviewRequest {
  kind: "code" | "contract";
  completion?: unknown;
  /** A code review of the whole change again, as on the first review, when the human asks for one. */
  full?: boolean;
}

export function reviewContext(
  s: Session,
  c: Contract,
  source: SourceSnapshot,
  base: SourceSnapshot,
  request: ReviewRequest,
  taskId?: string,
  allowFailedChecks = false,
): NonNullable<Round["review"]> {
  ensure(["code", "contract"].includes(request.kind), "Unknown review kind");
  if (request.kind === "contract") {
    ensure(
      request.completion === undefined,
      "Contract-only review does not accept code completion claims",
    );
    return { kind: "contract" };
  }
  ensure(
    !taskId,
    "Code review covers ALL planned work, not a selected task or batch",
  );
  readyContract(c);
  const report = record(request.completion, "Whole-work completion report");
  ensure(
    JSON.stringify(report).length <= 256_000,
    "Completion report exceeds 256,000 characters",
  );
  supported(report, ["summary", "tasks", "checks", "findings"]);
  text(report.summary, "Completion summary");
  const tasks = list(report.tasks, "Completed tasks").map((entry) => {
    const task = record(entry, "Completed task");
    supported(task, ["taskId", "evidence"]);
    return {
      taskId: identifier(task.taskId),
      evidence: text(task.evidence, "Task completion evidence"),
    };
  });
  ensure(
    tasks.length === c.tasks.length &&
      new Set(tasks.map((task) => task.taskId)).size === tasks.length &&
      tasks.every((task) => c.tasks.some((expected) => expected.id === task.taskId)),
    "Finish ALL planned tasks before review; report every task exactly once with implementation/acceptance evidence",
  );
  const checks = list(report.checks, "Completion checks").map((entry) => {
    const check = record(entry, "Completion check");
    supported(check, ["description", "outcome", "evidence", "extensions"]);
    ensure(
      (allowFailedChecks ? ["passed", "failed", "not_run"] : ["passed", "not_run"]).includes(check.outcome as string),
      "Fix all failed checks before code review; unavailable checks must be honestly not_run with limits",
    );
    return {
      description: text(check.description, "Check description"),
      outcome: check.outcome as "passed" | "failed" | "not_run",
      evidence: text(check.evidence, "Check evidence"),
      ...(check.extensions === undefined ? {} : { extensions: record(check.extensions, "Check extensions") }),
    };
  });
  ensure(
    checks.length > 0,
    "Record actual checks and any not_run limits before code review",
  );
  const findings = list(report.findings, "Completed finding dispositions", 6000).map((entry) => {
    const finding = record(entry, "Completed finding");
    supported(finding, ["requestId", "findingId", "disposition", "evidence"]);
    ensure(
      ["resolved", "disputed"].includes(finding.disposition as string),
      "Invalid completion finding disposition",
    );
    return {
      requestId: identifier(finding.requestId),
      findingId: identifier(finding.findingId),
      disposition: finding.disposition as "resolved" | "disputed",
      evidence: text(finding.evidence, "Finding completion evidence"),
    };
  });
  // Carry every assessed code-review finding, not only the last conversation preview.
  const required = s.rounds.flatMap((round) =>
    round.review?.kind === "code" && round.status === "ASSESSED"
      ? (round.reply?.findings ?? [])
          .filter((finding) => finding.severity !== "info")
          .map((finding) => `${round.id}:${finding.id}`)
      : [],
  );
  const supplied = findings.map(
    (finding) => `${finding.requestId}:${finding.findingId}`,
  );
  ensure(
    supplied.length === required.length &&
      new Set(supplied).size === supplied.length &&
      supplied.every((key) => required.includes(key)),
    "Finish ALL review fixes before re-review; record every prior actionable finding exactly once (requestId + findingId), with fix or dispute evidence",
  );
  const completion: WorkCompletion = {
    summary: report.summary as string, tasks, checks, findings,
  };
  const changedPaths = [
    ...new Set([...Object.keys(base.files), ...Object.keys(source.files)]),
  ].filter((path) => base.files[path] !== source.files[path]).sort();
  return { kind: "code", base, changedPaths, completion };
}
