import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { artifact, digest, json, listSessions, loadSession, now, runtimePath, safePath, sessionRelative, withLock } from "../files.ts";
import { versionDirectory } from "../render.ts";
import { projectRoot, snapshot } from "../source.ts";
import { commitWithCheckpoint as commit } from "../checkpoint.ts";
import { acceptedPlanCurrent, acceptedPlanRequestId, authorizationState, defaultRoundLimits, decisionSummary, requirementsText, scopeDigest } from "../state.ts";
import { ensure, identifier, text, validateContract, readyContract, readyPlan } from "../validation.ts";
import type { Contract, Session, Objective, RevisionReview } from "../types.ts";
import { resolveRevision, revisionChanges } from "../revision.ts";
import { requireOpen, resetReview, approvalIsCurrent, contract, contractFiles, nextRound } from "./shared.ts";

/** Starting a session, saving its context, authorising development, decisions and who does the work. */

function newSession(root: string, requirements: string, implementationOwner?: "main" | "delegate", objective?: Objective,
  automatic?: { id: string; origin: NonNullable<Session["autoPlanning"]> }, revisionReview?: RevisionReview): Session {
  const timestamp = now();
  const s: Session = {
    schemaVersion: 1,
    id: automatic?.id ?? randomUUID(),
    projectRoot: root,
    createdAt: timestamp,
    updatedAt: timestamp,
    sequence: 0,
    requirements: [requirements],
    contractVersion: 0,
    status: "DRAFT",
    rounds: [],
    artifacts: {},
    maxRounds: objective ? 20 : 12,
    ...(objective ? { objective, roundLimits: { ...defaultRoundLimits } } : {}),
    ...(automatic ? { autoPlanning: automatic.origin } : {}),
    contractReview: "NOT_REVIEWED",
    planApproval: null,
    ...(implementationOwner ? { implementationOwner } : {}),
    ...(revisionReview ? { revisionReview } : {}),
    deliveryVerified: false,
    verified: false,
  };
  return commit(root, s, "session.created", {
    "requirements.md": `${requirements}\n`,
  });
}
export function createSession(cwd: string, requirements: string, implementationOwner?: "main" | "delegate", objective?: Objective): Session {
  const root = projectRoot(cwd);
  text(requirements, "Original requirements", 64_000);
  ensure(implementationOwner === undefined || ["main", "delegate"].includes(implementationOwner), "Invalid implementation owner");
  ensure(objective === undefined || ["planning", "development", "review"].includes(objective), "Invalid objective");
  return withLock(root, () => newSession(root, requirements, implementationOwner, objective));
}
/**
 * A review session for an existing change (/waicc-review --rev). The range is checked against
 * the repository first, so a typo or an empty range makes no session.
 */
export function createRevisionReview(cwd: string, input: string | RevisionReview, focus: string): Session {
  const root = projectRoot(cwd);
  const revisionReview = typeof input === "string" ? resolveRevision(root, input, snapshot(root).vcs) : input;
  revisionChanges(root, revisionReview);
  const requirements = `Review the code change ${revisionReview.label}${focus.trim() ? `: ${focus.trim()}` : ""}`;
  return withLock(root, () => newSession(root, requirements, undefined, "review", undefined, revisionReview));
}
/** A merge request fetched again: later code reviews in its session cover its new head. */
export function refreshRevisionReview(cwd: string, id: string, revisionReview: RevisionReview): Session {
  const root = projectRoot(cwd);
  revisionChanges(root, revisionReview);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    ensure(s.revisionReview?.mergeRequest, "Only a merge request review session can be fetched again");
    ensure(!s.rounds.some((r) => r.status === "WAITING" || r.status === "RECEIVED"), "Continue or cancel the pending review before fetching the merge request again");
    s.revisionReview = revisionReview;
    return commit(root, s, "revision.refreshed", {});
  });
}
export interface PostedComments {
  postedAt: string; requestId: string; headSha: string; webUrl: string;
  comments: { findingId: string; key: string; inline: boolean; noteId: number | null }[];
  summaryNoteId: number | null;
}
/** What was posted to the merge request, kept in the session; earlier posts are never repeated. */
export function recordPostedComments(cwd: string, id: string, posted: PostedComments): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    return commit(root, s, "merge-request.commented", { [`mr-comments/${now().replace(/[^0-9]/g, "")}-${randomUUID().slice(0, 8)}.json`]: json(posted) });
  });
}
export function postedComments(cwd: string, id: string): PostedComments[] {
  const root = projectRoot(cwd);
  const s = loadSession(root, id);
  return Object.keys(s.artifacts).filter((path) => /^mr-comments\/[^/]+\.json$/.test(path)).sort()
    .map((path) => JSON.parse(artifact(root, s, path)) as PostedComments);
}
/** One atomic planning-only start per captured Pi input, including retry after an interrupted bind. */
export function createAutoPlanningSession(cwd: string, requirements: string, chatId: string, requestId: string): Session {
  const root = projectRoot(cwd);
  text(requirements, "Original requirements", 64_000);
  text(chatId, "Pi chat ID", 1024);
  identifier(requestId, "Automatic planning request ID");
  const hash = digest(json([root, chatId, requestId]));
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const origin = { chatId, requestId, requirementsDigest: digest(requirements) };
  return withLock(root, () => {
    ensure(!existsSync(safePath(root, `${runtimePath}/deleted-sessions/${id}`)), "This automatic request belongs to a deleted contract. Restore/select it explicitly; do not recreate it.");
    if (existsSync(safePath(root, sessionRelative(id)))) {
      const s = loadSession(root, id);
      ensure(s.autoPlanning?.chatId === chatId && s.autoPlanning.requestId === requestId &&
        s.autoPlanning.requirementsDigest === origin.requirementsDigest && s.requirements[0] === requirements,
        "Automatic planning origin conflicts with stored requirements; inspect the existing contract");
      ensure(s.status !== "CLOSED", "This automatic request's contract is closed. Reopen/select it explicitly; do not recreate it.");
      return s;
    }
    ensure(!listSessions(root).some((s) => s.status !== "CLOSED"), "Open WAICC contracts already exist. Select one with /waicc-use <session-id>, or explicitly start separate work with /waicc-planning <requirements>; automatic planning will not guess.");
    return newSession(root, requirements, undefined, "planning", { id, origin });
  });
}
/** Saved owner context is supplementary evidence; only amendments change scope. */
export function saveContext(cwd: string, id: string, summary: string): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    ensure(!s.rounds.some((r) => ["WAITING", "RECEIVED"].includes(r.status)), "Finish/cancel the pending handoff before updating coordinator context");
    const artifactPath = `context/${randomUUID()}.md`;
    s.context = { summary: text(summary, "Coordinator context"), updatedAt: now(), artifactPath };
    return commit(root, s, "context.saved", { [artifactPath]: `${summary}\n` });
  });
}
export function requireAcceptedPlan(root: string, s: Session): void {
  ensure(acceptedPlanCurrent(root, s), "Accept a current planning reply before delegating implementation/testing");
}
function noPending(s: Session): void {
  ensure(!s.rounds.some((r) => ["WAITING", "RECEIVED"].includes(r.status)), "Finish/cancel the pending handoff before this human decision; its frozen inputs cannot change");
}
function noFailedSpecification(s: Session): void {
  const latest = s.rounds.findLast((r) => r.mode === "review" && r.review?.kind !== "code" && r.status === "ASSESSED" && r.contractVersion === s.contractVersion);
  ensure(!latest || !["needs_changes", "blocked"].includes(latest.decision ?? ""), "Specification review still requires changes; resolve and assess the current specification before development");
}
function grantImplementation(s: Session, c: Contract, source: string, origin: NonNullable<Session["implementationAuthorization"]>["origin"], files: Record<string, string>): void {
  const id = randomUUID(), artifactPath = `authorizations/${id}.json`;
  s.objective = "development";
  s.implementationAuthorization = { id, artifactPath, origin, grantedAt: now(), contractVersion: s.contractVersion,
    requirementsDigest: digest(requirementsText(s)), allowedPathsDigest: scopeDigest(c), sourceFingerprint: source };
  files[artifactPath] = json({ ...s.implementationAuthorization, implementationOwner: s.implementationOwner ?? "main",
    allowedPaths: c.tasks.map((t) => ({ taskId: t.id, allowedPaths: t.allowedPaths })),
    limits: "Human authorization for the exact plan only. Decision gates, scope and host permissions remain in force; no installs, production actions, commits, pushes or deployment are implied." });
}
/** Explicit human transition; a PASS is evidence, never an implicit grant. */
/** `origin` records how the human authorized it: /waicc-develop, or --develop typed on a planning dispatch. */
export function beginDevelopment(cwd: string, id: string, owner?: "main" | "delegate", origin: "human-develop" | "human-dispatch-develop" = "human-develop"): Session {
  const root = projectRoot(cwd);
  ensure(owner === undefined || ["main", "delegate"].includes(owner), "Invalid implementation owner");
  return withLock(root, () => {
    const s = loadSession(root, id); requireOpen(s); noPending(s);
    ensure(s.contractVersion > 0, "Prepare and accept a source-backed plan or obtain specification PASS first");
    const v = contract(root, s), source = snapshot(root);
    readyPlan(v.contract);
    if (authorizationState(s, v.contract).authorized && (!owner || owner === (s.implementationOwner ?? "main")) && s.status !== "SPEC_APPROVED") return s;
    ensure(v.requirementsDigest === digest(requirementsText(s)), "Requirements changed; reconcile and accept the current plan first");
    const specPass = (s.reviewApproval?.kind ?? "contract") === "contract" && approvalIsCurrent(s, source.fingerprint);
    noFailedSpecification(s);
    const acceptedRequestId = acceptedPlanRequestId(root, s);
    ensure(acceptedRequestId || specPass, "Accept the current source-backed planning reply or obtain a fresh specification PASS before /waicc-develop");
    if (owner) s.implementationOwner = owner;
    s.planApproval = { contractVersion: s.contractVersion, requirementsDigest: v.requirementsDigest,
      requestId: specPass ? s.reviewApproval!.requestId : acceptedRequestId! };
    const files: Record<string, string> = {};
    grantImplementation(s, v.contract, source.fingerprint, origin, files);
    s.status = decisionSummary(v.contract).openGates ? "IMPLEMENTATION_GATED" : "READY_TO_IMPLEMENT";
    return commit(root, s, "development.authorized-by-human", files);
  });
}

export function decisionsView(cwd: string, id: string) {
  const root = projectRoot(cwd), s = loadSession(root, id);
  ensure(s.contractVersion > 0, "Prepare a contract before inspecting its decisions");
  const c = contract(root, s).contract;
  return { sessionId: s.id, contractVersion: s.contractVersion, ...decisionSummary(c),
    decisions: c.decisions ?? [], briefPath: s.artifacts[`${versionDirectory(s.contractVersion)}/DECISIONS.md`]
      ? join(root, sessionRelative(s.id), versionDirectory(s.contractVersion), "DECISIONS.md") : null,
    nextAction: "Investigate agent-owned facts first. The human may /waicc-decide <decision-id> <answer> after pending work is assessed/cancelled. Scope changes require /waicc-amend, not a decision answer." };
}
/** One line per open decision and the exact command, for messages to the human. */
export function openDecisionsText(c: Contract): string {
  const open = (c.decisions ?? []).filter((d) => d.status !== "resolved");
  return open.length
    ? `Open decisions: ${open.map((d) => `${d.id} (${d.owner}): ${d.question}`).join("; ")}. Use /waicc-decide <ID> <answer>, /waicc-decide <ID> recommended, or /waicc-decide alone to pick one.`
    : "There are no open decisions; /waicc-decisions shows them all.";
}

/** Resolves only an existing gate; no task, path, requirement or scope rewriting. */
/** Who decided: the human by command, a standing policy the human wrote, or the human's low-risk setting. */
export type DecisionSource = { kind: "human" } | { kind: "policy"; policy: string; rationale: string } | { kind: "auto-low-risk" };

export function resolveDecision(cwd: string, id: string, decisionId: string, answer: string, by: DecisionSource = { kind: "human" }): Session {
  const root = projectRoot(cwd); identifier(decisionId); text(answer, "Decision answer");
  return withLock(root, () => {
    const s = loadSession(root, id); requireOpen(s); noPending(s);
    ensure(s.contractVersion > 0, "Prepare a contract before answering its decisions");
    const v = contract(root, s), c = structuredClone(v.contract);
    // IDs match regardless of case (d6 is D6); an unknown one lists the open decisions to choose from.
    const decision = c.decisions?.find((d) => d.id.toLowerCase() === decisionId.toLowerCase());
    ensure(decision, `Unknown decision ID ${JSON.stringify(decisionId)}. ${openDecisionsText(c)}`);
    decisionId = decision.id;
    if (decision.status === "resolved") {
      ensure(decision.answer === answer, "Decision is already resolved differently; revise/amend explicitly rather than replacing an established answer");
      return s;
    }
    const acceptedRequestId = acceptedPlanRequestId(root, s);
    const accepted = Boolean(acceptedRequestId) || ((s.reviewApproval?.kind ?? "contract") === "contract" && approvalIsCurrent(s, snapshot(root).fingerprint));
    const wasAuthorized = authorizationState(s, c).authorized;
    const recordId = randomUUID(), path = `decisions/${recordId}.json`, oldVersion = s.contractVersion;
    decision.status = "resolved"; decision.answer = answer;
    decision.evidence.push(by.kind === "policy"
      ? `Resolved by the human's standing policy "${by.policy}" (applied by the coordinator: ${by.rationale}); record in ${path}`
      : by.kind === "auto-low-risk"
        ? `Recommendation accepted automatically under the human's autoDecide low-risk setting (low risk, reversible); record in ${path}`
        : `Human-recorded answer; exact text and provenance retained in ${path}`);
    validateContract(c, requirementsText(s));
    s.contractVersion++;
    s.planApproval = accepted ? { contractVersion: s.contractVersion, requirementsDigest: digest(requirementsText(s)),
      requestId: acceptedRequestId ?? s.reviewApproval!.requestId } : null;
    resetReview(s); // The changed version never inherits specification/code PASS.
    const source = snapshot(root), files = contractFiles(s, c, source);
    files[path] = json({ id: recordId, decisionId, answer, recordedAt: now(), recordedBy: by.kind === "policy" ? "standing-policy" : by.kind === "auto-low-risk" ? "auto-low-risk" : "human-command",
      ...(by.kind === "policy" ? { policy: by.policy, rationale: by.rationale } : {}), previousVersion: oldVersion, contractVersion: s.contractVersion,
      requirementsDigest: digest(requirementsText(s)), scopeChanged: false, reviewInvalidated: true });
    if (wasAuthorized) grantImplementation(s, c, source.fingerprint, "human-decision-resolution", files);
    s.status = wasAuthorized ? decisionSummary(c).openGates ? "IMPLEMENTATION_GATED" : "READY_TO_IMPLEMENT" : accepted ? "PLAN_READY" : "NEEDS_CHANGES";
    return commit(root, s, by.kind === "human" ? "decision.answered-by-human" : `decision.answered-by-${by.kind}`, files);
  });
}
/** Explicit human command selects delegation; subsequent agent requests honor that choice. */
export function delegateWork(cwd: string, id: string, mode: "implementation" | "testing", focus: string): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    ensure(["implementation", "testing"].includes(mode), "Unknown delegated work mode");
    requireAcceptedPlan(root, s);
    if (mode === "implementation") s.implementationOwner = "delegate";
    const files: Record<string, string> = {};
    if (mode === "implementation") {
      noPending(s);
      noFailedSpecification(s);
      const v = contract(root, s);
      ensure(v.requirementsDigest === digest(requirementsText(s)), "Requirements changed; reconcile the plan first");
      readyContract(v.contract);
      grantImplementation(s, v.contract, snapshot(root).fingerprint, "human-implementation-delegation", files);
    } else if (s.objective) ensure(authorizationState(s, contract(root, s).contract).authorized, "Testing delegation requires current development authorization; use /waicc-develop");
    if (mode === "testing") s.testingOwner = "delegate";
    const next = nextRound(s, contract(root, s), mode, text(focus, "Assignment focus"), undefined, undefined, undefined, true);
    return commit(root, s, "work.delegated-by-human", { ...files, ...next.files });
  });
}
export function useMainWork(cwd: string, id: string, mode: "implementation" | "testing"): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    ensure(["implementation", "testing"].includes(mode), "Unknown work mode");
    ensure(!s.rounds.some((round) => ["WAITING", "RECEIVED"].includes(round.status)), "Finish/cancel the pending handoff before switching work back to the main agent; this does not stop external workers");
    requireAcceptedPlan(root, s);
    if (s.objective) ensure(authorizationState(s, contract(root, s).contract).authorized, "No current development authorization; use /waicc-develop before selecting the main worker");
    if (mode === "implementation") s.implementationOwner = "main";
    else s.testingOwner = "main";
    return commit(root, s, "work.main-selected-by-human");
  });
}
