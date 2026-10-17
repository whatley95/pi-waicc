import { artifact, digest, json } from "./files.ts";
import { versionDirectory, roundDirectory } from "./render.ts";
import { decisionGates } from "./decisions.ts";
import type { Contract, Mode, Round, RoundPhase, Session } from "./types.ts";

export const requirementsText = (s: Session): string => s.requirements
  .map((r, i) => i ? `\n## Amendment ${i}\n\n${r}` : r).join("\n");
export const scopeDigest = (c: Contract) => digest(json(c.tasks.map((t) => ({ id: t.id, allowedPaths: t.allowedPaths }))));
export const defaultRoundLimits: Record<RoundPhase, number> = {
  specification: 8, implementation: 6, testing: 4, code_review: 8, advisor: 4,
};
export const roundPhase = (mode: Mode, kind?: "code" | "contract"): RoundPhase =>
  mode === "planning" || (mode === "review" && kind !== "code") ? "specification"
    : mode === "review" ? "code_review" : mode;
export const reviewKindLabel = (r?: Round) => r?.mode !== "review" ? null
  : !r.review ? "legacy_contract" : ["code", "contract"].includes(r.review.kind) ? r.review.kind : "unknown";

/** Legacy acceptance is established from immutable planning assessment, not a PASS label. */
export function acceptedPlanRequestId(root: string, s: Session): string | null {
  if (s.planApproval !== undefined) return s.planApproval &&
    s.planApproval.contractVersion === s.contractVersion && s.planApproval.requirementsDigest === digest(requirementsText(s)) ? s.planApproval.requestId : null;
  if (!s.contractVersion) return null;
  const read = (version: number) => JSON.parse(artifact(root, s, `${versionDirectory(version)}/contract.json`)).contract as Contract;
  const current = read(s.contractVersion);
  return s.rounds.findLast((r) => {
    if (r.mode !== "planning" || r.status !== "ASSESSED" || !["planned", "ready"].includes(r.decision ?? "") ||
      r.requirementsDigest !== digest(requirementsText(s))) return false;
    const assessment = JSON.parse(artifact(root, s, `${roundDirectory(r)}/assessment.json`)) as { contract?: Contract };
    return digest(json(assessment.contract ?? read(r.contractVersion))) === digest(json(current));
  })?.id ?? null;
}
export const acceptedPlanCurrent = (root: string, s: Session): boolean => acceptedPlanRequestId(root, s) !== null;

export function authorizationState(s: Session, c: Contract | null) {
  const a = s.implementationAuthorization;
  const current = Boolean(c && a && s.objective === "development" && s.status !== "CLOSED" &&
    a.contractVersion === s.contractVersion && a.requirementsDigest === digest(requirementsText(s)) && a.allowedPathsDigest === scopeDigest(c));
  return {
    authorized: current, record: a ?? null,
    reason: current ? "Human development authorization matches this contract, requirements and allowed paths; decision gates still apply."
      : s.status === "CLOSED" ? "Contract is CLOSED; human reopening and fresh authorization are required."
      : a ? "Development authorization is stale after a contract/scope change; use /waicc-develop after accepting the current plan."
      : "No recorded development authorization. Planning/specification PASS and ownership are not permission to build; use /waicc-develop.",
  };
}
export function roundUsage(s: Session) {
  return { overall: { used: s.rounds.length, limit: s.maxRounds, remaining: Math.max(0, s.maxRounds - s.rounds.length) },
    phases: Object.fromEntries(Object.keys(defaultRoundLimits).map((key) => {
      const phase = key as RoundPhase, used = s.rounds.filter((r) => (r.phase ?? roundPhase(r.mode, r.review?.kind)) === phase).length;
      const limit = s.roundLimits?.[phase] ?? null;
      return [phase, { used, limit, remaining: limit === null ? null : Math.max(0, limit - used) }];
    })) };
}
export function sessionPhase(s: Session): string {
  if (s.status === "CLOSED") return "closed";
  const pending = s.rounds.findLast((r) => ["WAITING", "RECEIVED"].includes(r.status));
  if (pending) return pending.phase ?? roundPhase(pending.mode, pending.review?.kind);
  if (s.status === "NEEDS_TESTING") return "testing";
  if (s.status === "NEEDS_REVIEW" || (s.status === "READY_TO_CLOSE" && s.reviewApproval?.kind === "code")) return "code_review";
  if (s.objective === "development") return "implementation";
  if (s.contractReview === "PASS") return "specification";
  return "planning";
}
/** Claims are counted only for their exact version and observed source, never as verification. */
export function progressState(root: string, s: Session, c: Contract | null, source: string) {
  const report = s.rounds.findLast((r) => r.contractVersion === s.contractVersion && r.requirementsDigest === digest(requirementsText(s)) &&
    ((r.status === "ASSESSED" && r.decision === "ready" && r.reply?.completion) || r.review?.kind === "code"));
  const observedPath = report && `${roundDirectory(report)}/observed-source.json`;
  const reportSource = report && observedPath && s.artifacts[observedPath]
    ? (JSON.parse(artifact(root, s, observedPath)) as { fingerprint: string }).fingerprint : report?.source.fingerprint;
  const completion = report?.reply?.completion ?? (report?.review?.kind === "code" ? report.review.completion : undefined);
  return { totalTasks: c?.tasks.length ?? 0,
    reportedCompleteTasks: completion && reportSource === source ? completion.tasks.filter((t) => c?.tasks.some((expected) => expected.id === t.taskId)).length : null,
    reportRequestId: report?.id ?? null, reportMatchesCurrentSource: report ? reportSource === source : null,
    deliveryVerified: false, note: "Reported complete is a claim, not verified delivery. null means no current whole-work report, not zero implementation." };
}
export function decisionSummary(c: Contract) {
  const gates = decisionGates(c);
  return { ...gates, openGates: gates.pendingDecisions.length, blockedTasks: gates.decisionBlockedTaskIds.length,
    unblockedTasks: gates.decisionUnblockedTaskIds.length };
}

export function reviewState(s: Session, kind: "code" | "contract", source: string) {
  const r = s.rounds.findLast((round) => round.mode === "review" && (round.review?.kind ?? "contract") === kind);
  const versionCurrent = Boolean(r && r.contractVersion === s.contractVersion && r.requirementsDigest === digest(requirementsText(s)));
  const sourceCurrent = Boolean(r && r.source.fingerprint === source);
  return { status: !r ? "NOT_REVIEWED" : !versionCurrent || !sourceCurrent || r.status === "STALE" ? "STALE"
      : r.status === "CANCELLED" ? "CANCELLED" : ["WAITING", "RECEIVED"].includes(r.status) ? "PENDING"
      : r.decision === "ready" ? "PASS" : r.decision === "blocked" ? "BLOCKED" : "NEEDS_CHANGES",
    requestId: r?.id ?? null, kind: reviewKindLabel(r), contractVersion: r?.contractVersion ?? null,
    recordedDecision: r?.decision ?? null, versionCurrent, sourceCurrent,
    note: kind === "contract" ? "Specification evidence only; never code approval, implementation permission or progress." : "Independent whole-change review evidence, not delivery certification." };
}
