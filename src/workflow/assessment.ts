import { artifact, digest, json, loadSession, now, safePath, withLock } from "../files.ts";
import { roundDirectory, versionDirectory } from "../render.ts";
import { projectRoot, snapshot } from "../source.ts";
import { commitWithCheckpoint as commit } from "../checkpoint.ts";
import { acceptedPlanCurrent, requirementsText } from "../state.ts";
import { ensure, identifier, list, record, text, validateContract, readyContract, readyPlan } from "../validation.ts";
import type { Contract, ContractVersion, Session } from "../types.ts";
import { requireOpen, resetReview, contract, contractFiles, parsedContract, stableIds, nextRound } from "./shared.ts";

/** Assessing a reply: the owner's decision, adopted revisions, dispositions and the next state. */

export interface Assessment {
  requestId: string;
  decision:
    "ready" | "planned" | "noted" | "followup" | "needs_changes" | "blocked";
  rationale: string;
  contract?: Contract;
  dispositions: {
    findingId: string;
    disposition: "resolved" | "disputed";
    evidence: string;
  }[];
}
export function assess(cwd: string, id: string, a: Assessment): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    identifier(a.requestId);
    const r = s.rounds.find((round) => round.id === a.requestId);
    ensure(
      r?.status === "RECEIVED" && r.reply,
      "Only a received, current reply can be assessed",
    );
    text(a.rationale, "Assessment rationale");
    ensure(
      [
        "ready",
        "planned",
        "noted",
        "followup",
        "needs_changes",
        "blocked",
      ].includes(a.decision),
      "Unknown assessment decision",
    );
    ensure(
      a.decision !== "planned" || r.mode === "planning",
      "The planned assessment is only valid for planning",
    );
    ensure(
      !((r.review?.kind === "code" || r.wholeWork) && a.decision === "followup"),
      "Code-review findings go back to the main agent: assess needs_changes/blocked, finish ALL fixes, then request one fresh whole-work code review with completion evidence",
    );
    if (r.mode === "testing") ensure(a.contract === undefined, "Testing assessments cannot rewrite the contract; report defects and revise scope explicitly");
    if (r.mode === "advisor") {
      ensure(
        a.decision !== "ready",
        "Advisor advice cannot authorize readiness; use noted or followup",
      );
      ensure(
        a.contract === undefined,
        "Advisor assessments cannot change the contract; explicitly prepare a later revision after a human decision",
      );
      if (a.decision === "noted")
        ensure(
          r.reply.outcome === "ready" && r.reply.questions.length === 0,
          "Incomplete advice or unresolved questions require a followup or blocker decision",
        );
    } else
      ensure(
        a.decision !== "noted",
        "The noted decision is only valid for advisor replies",
      );
    ensure(
      r.requirementsDigest === digest(requirementsText(s)) &&
        r.contractVersion === s.contractVersion,
      "Requirements or contract changed; issue a fresh request",
    );
    const currentSource = snapshot(root);
    const intakeSource = JSON.parse(
      artifact(root, s, `${roundDirectory(r)}/observed-source.json`),
    ) as { fingerprint: string };
    ensure(
      currentSource.fingerprint === intakeSource.fingerprint,
      "Source changed after reply intake; issue a fresh request",
    );
    const seen = new Set<string>();
    for (const item of list(a.dispositions, "Finding dispositions")) {
      const d = record(item, "Disposition");
      identifier(d.findingId);
      text(d.evidence, "Disposition evidence");
      ensure(
        ["resolved", "disputed"].includes(d.disposition as string) &&
          r.reply.findings.some((f) => f.id === d.findingId) &&
          !seen.has(d.findingId as string),
        "Invalid or duplicate finding disposition",
      );
      seen.add(d.findingId as string);
    }
    const files: Record<string, string> = {};
    ensure(
      !(
        r.mode === "review" &&
        a.decision === "ready" &&
        a.contract !== undefined
      ),
      "A changed contract requires a fresh review. Adopt it with followup or needs_changes, not a ready review assessment.",
    );
    let c = contract(root, s).contract;
    if (a.contract) {
      const keepPlanApproval = r.review?.kind === "code" && acceptedPlanCurrent(root, s);
      c = validateContract(a.contract, requirementsText(s));
      stableIds(contract(root, s).contract, c);
      c.tasks
        .flatMap((t) => t.allowedPaths)
        .forEach((path) => safePath(root, path));
      s.contractVersion++;
      s.planApproval = keepPlanApproval ? { contractVersion: s.contractVersion, requirementsDigest: digest(requirementsText(s)), requestId: r.id } : null;
      Object.assign(files, contractFiles(s, c, currentSource));
    }
    if (a.decision === "ready" || a.decision === "planned") {
      if (r.review?.kind === "code") readyContract(c);
      else if (a.decision === "planned" || r.mode === "review") readyPlan(c);
      else readyContract(c);
      if (r.mode === "implementation") {
        const tasks = r.taskId
          ? c.tasks.filter((task) => task.id === r.taskId)
          : c.tasks;
        const allowed = tasks.flatMap((task) => task.allowedPaths);
        const changed = [
          ...new Set([
            ...Object.keys(r.source.files),
            ...Object.keys(currentSource.files),
          ]),
        ].filter((path) => r.source.files[path] !== currentSource.files[path]);
        const outside = changed.filter(
          (path) =>
            !allowed.some(
              (scope) => path === scope || path.startsWith(`${scope}/`),
            ),
        );
        ensure(
          outside.length === 0,
          `Implementation changed paths outside its contract: ${outside.slice(0, 10).join(", ")}`,
        );
      }
      ensure(
        r.reply.questions.length === 0 &&
          r.reply.coverage.every((row) => row.status === "addressed") &&
          r.reply.checks.every((check) => check.outcome !== "failed"),
        "Unresolved questions, coverage gaps or failed checks prevent ready",
      );
      ensure(
        r.reply.outcome === "ready" ||
          (a.decision === "planned" && r.reply.outcome === "planned"),
        "Reply did not report readiness; resolve it in a follow-up round",
      );
      ensure(
        r.reply.findings
          .filter((f) => ["critical", "high"].includes(f.severity))
          .every((f) => seen.has(f.id)),
        "High/critical findings need explicit evidence-backed dispositions",
      );
      if (r.review?.kind === "code" || r.wholeWork)
        ensure(
          r.reply.findings
            .filter((finding) => finding.severity !== "info")
            .every((finding) => a.dispositions.some((disposition) =>
              disposition.findingId === finding.id && disposition.disposition === "disputed")),
          "Actionable code findings require ALL fixes and a fresh review; only evidence-backed false-positive disputes can pass without code changes",
        );
    }
    const assessedAt = now();
    r.status = "ASSESSED";
    r.decision = a.decision;
    r.rationale = a.rationale;
    r.dispositions = a.dispositions;
    files[`${roundDirectory(r)}/assessment.json`] = json({
      ...a,
      at: assessedAt,
      verified: false,
      deliveryVerified: false,
    });
    files[`${roundDirectory(r)}/ASSESSMENT.md`] =
      `# ${a.decision}\n\n${a.rationale}\n\nRequest: ${r.id}. Delivery verified: false.\n\n## Finding dispositions\n\n${a.dispositions.map((d) => `- ${d.findingId}: ${d.disposition}. Evidence: ${d.evidence}`).join("\n") || "None."}\n`;
    if (a.decision === "planned" || (s.objective && r.mode === "planning" && a.decision === "ready")) {
      s.status = "PLAN_READY";
      s.planApproval = { contractVersion: s.contractVersion, requirementsDigest: digest(requirementsText(s)), requestId: r.id };
      resetReview(s);
    } else if (a.decision === "ready" && r.mode === "planning") {
      s.planApproval = { contractVersion: s.contractVersion, requirementsDigest: digest(requirementsText(s)), requestId: r.id };
      const v = a.contract
        ? parsedContract(root, s, files[`${versionDirectory(s.contractVersion)}/contract.json`])
        : contract(root, s);
      const next = nextRound(
        s,
        v,
        "implementation",
        "Implement the accepted task contracts in dependency order. Actual implementation begins only when the human submits this handoff to a coding agent.",
      );
      Object.assign(files, next.files);
    } else if (a.decision === "noted") {
      s.status = "ADVICE_READY";
    } else if (a.decision === "ready") {
      if (r.mode === "review" && !r.taskId) {
        s.status = s.objective && r.review?.kind !== "code" ? "SPEC_APPROVED" : "READY_TO_CLOSE";
        s.contractReview = "PASS";
        s.reviewApproval = {
          kind: r.review?.kind ?? "contract",
          requestId: r.id,
          contractVersion: s.contractVersion,
          requirementsDigest: r.requirementsDigest,
          sourceFingerprint: currentSource.fingerprint,
          assessedAt,
        };
      } else {
        s.status = r.mode === "implementation" && r.wholeWork &&
          (r.reply.checks.length === 0 || r.reply.checks.some((check) => check.outcome === "not_run"))
          ? "NEEDS_TESTING" : "NEEDS_REVIEW";
        resetReview(s);
      }
    } else if (a.decision === "followup") {
      const v = a.contract
        ? parsedContract(root, s, files[`${versionDirectory(s.contractVersion)}/contract.json`])
        : contract(root, s);
      Object.assign(
        files,
        nextRound(
          s,
          v,
          r.mode === "implementation" ? "review" : r.mode,
          a.rationale,
          r.taskId ?? undefined,
          r.advisor?.requirementIds,
        ).files,
      );
    } else {
      s.status = a.decision === "blocked" ? "BLOCKED" : "NEEDS_CHANGES";
      if (r.mode === "review")
        s.contractReview =
          a.decision === "blocked" ? "BLOCKED" : "NEEDS_CHANGES";
    }
    return commit(root, s, "reply.assessed", files);
  });
}
