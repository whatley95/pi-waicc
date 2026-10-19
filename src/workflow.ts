import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifact,
  digest,
  json,
  listSessions,
  listDeletedSessions,
  loadSession,
  now,
  readJson,
  readText,
  runtimePath,
  safePath,
  sessionRelative,
  withLock,
} from "./files.ts";
import {
  contractMarkdown,
  conversation,
  handoff,
  manualHandoff,
  replyTemplate,
  roundDirectory,
  starterPrompt,
  proposedContractExample,
  versionDirectory,
} from "./render.ts";
import { projectRoot, snapshot } from "./source.ts";
import { recall } from "./memory.ts";
import { normalizeReply, replyNormalizerVersion } from "./reply.ts";
import { decisionGates, decisionBrief } from "./decisions.ts";
import { reviewContext, type ReviewRequest } from "./review.ts";
import { contextPacket } from "./context.ts";
import { commitWithCheckpoint as commit, checkpointData } from "./checkpoint.ts";
import { acceptedPlanCurrent, acceptedPlanRequestId, authorizationState, defaultRoundLimits, decisionSummary, progressState,
  requirementsText, reviewKindLabel, reviewState, roundPhase, roundUsage, scopeDigest, sessionPhase } from "./state.ts";
export { requirementsText } from "./state.ts";
import {
  ensure,
  identifier,
  list,
  record,
  relativePath,
  text,
  validateContract,
  validateReply,
  readyContract,
  readyPlan,
} from "./validation.ts";
import type {
  Contract,
  ContractVersion,
  Mode,
  Reply,
  Round,
  Session,
  Objective,
  RoundPhase,
} from "./types.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
function requireOpen(s: Session): void {
  ensure(
    s.status !== "CLOSED",
    "Contract is closed. Use /waicc-reopen <reason> before changing it.",
  );
}
function resetReview(s: Session): void {
  s.contractReview = "NOT_REVIEWED";
  delete s.reviewApproval;
}
function approvalIsCurrent(s: Session, sourceFingerprint: string): boolean {
  const approval = s.reviewApproval;
  const last = s.rounds.at(-1);
  return Boolean(
    approval &&
    s.contractReview === "PASS" &&
    approval.contractVersion === s.contractVersion &&
    approval.requirementsDigest === digest(requirementsText(s)) &&
    approval.sourceFingerprint === sourceFingerprint &&
    last?.id === approval.requestId &&
    last.mode === "review" &&
    (approval.kind ?? "contract") === (last.review?.kind ?? "contract") &&
    !last.taskId &&
    last.status === "ASSESSED" &&
    last.decision === "ready" &&
    last.contractVersion === approval.contractVersion &&
    last.requirementsDigest === approval.requirementsDigest &&
    last.source.fingerprint === approval.sourceFingerprint &&
    last.reply?.outcome === "ready",
  );
}
function contract(
  root: string,
  s: Session,
  version = s.contractVersion,
): ContractVersion {
  return JSON.parse(
    artifact(root, s, `${versionDirectory(version)}/contract.json`),
  ) as ContractVersion;
}
export function readContract(cwd: string, id: string): ContractVersion {
  const root = projectRoot(cwd);
  return contract(root, loadSession(root, id));
}
function contractFiles(
  s: Session,
  c: Contract,
  source = snapshot(s.projectRoot),
): Record<string, string> {
  const v: ContractVersion = {
    schemaVersion: 1,
    sessionId: s.id,
    version: s.contractVersion,
    createdAt: now(),
    requirementsDigest: digest(requirementsText(s)),
    source,
    contract: c,
  };
  return {
    [`${versionDirectory(v.version)}/contract.json`]: json(v),
    [`${versionDirectory(v.version)}/CONTRACT.md`]: contractMarkdown(v),
    [`${versionDirectory(v.version)}/DECISIONS.md`]: `Contract v${v.version}; session ${s.id}.\n\n${decisionBrief(c)}`,
  };
}
function stableIds(previous: Contract, next: Contract): void {
  ensure(
    previous.requirements.every((r) =>
      next.requirements.some(
        (n) => n.id === r.id && n.sourceQuote === r.sourceQuote,
      ),
    ),
    "Preserve requirement IDs and original quotes across revisions; record scope changes as amendments",
  );
  ensure(
    (previous.decisions ?? []).every((d) =>
      (next.decisions ?? []).some(
        (n) => n.id === d.id && n.question === d.question,
      ),
    ),
    "Preserve decision IDs/questions across revisions; carry answers and evidence forward instead of dropping prior decisions",
  );
}
function skillFiles(names: string[], prefix: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [...new Set([...names, "waicc-workflow"])]) {
    ensure(/^[a-z0-9-]+$/.test(name), "Invalid skill name");
    const root = safePath(packageRoot, `skills/${name}`);
    ensure(existsSync(root), `Unknown packaged skill: ${name}`);
    const walk = (relative: string): void => {
      for (const entry of readdirSync(
        relative ? safePath(root, relative) : root,
        { withFileTypes: true },
      )) {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        const full = safePath(root, path);
        ensure(!entry.isSymbolicLink(), "Skill symlinks are unsupported");
        if (entry.isDirectory()) walk(path);
        else result[`${prefix}/skills/${name}/${path}`] = readText(full);
      }
    };
    walk("");
  }
  return result;
}
function nextRound(
  s: Session,
  v: ContractVersion,
  mode: Mode,
  focus: string,
  taskId?: string,
  requirementIds?: string[],
  review?: ReviewRequest,
  wholeWork = false,
): { round: Round; files: Record<string, string> } {
  requireOpen(s);
  ensure(
    ["planning", "review", "implementation", "testing", "advisor"].includes(mode),
    "Unknown request mode",
  );
  let advisor: Round["advisor"];
  if (mode === "advisor") {
    ensure(
      !taskId,
      "Advisor scope uses requirement IDs, not implementation tasks",
    );
    const ids = list(requirementIds ?? [], "Advisor requirement IDs").map(
      (value) => identifier(value),
    );
    ensure(
      new Set(ids).size === ids.length &&
        ids.every((id) => v.contract.requirements.some((req) => req.id === id)),
      "Advisor scope contains unknown or duplicate requirement IDs",
    );
    advisor = { question: focus, requirementIds: ids };
  } else
    ensure(
      requirementIds === undefined,
      "Requirement scope is only supported for advisor requests",
    );
  ensure(
    !s.rounds.some((r) => r.status === "WAITING" || r.status === "RECEIVED"),
    "Assess or explicitly cancel the pending request before issuing another",
  );
  ensure(
    s.rounds.length < s.maxRounds,
    `Session reached its ${s.maxRounds}-round limit. Stop and resolve the blocker; adjust the limit explicitly if justified.`,
  );
  const phase = roundPhase(mode, review?.kind);
  const phaseLimit = s.roundLimits?.[phase];
  ensure(phaseLimit === undefined || s.rounds.filter((r) => (r.phase ?? roundPhase(r.mode, r.review?.kind)) === phase).length < phaseLimit,
    `Session reached its ${phase} phase limit (${phaseLimit}); stop and resolve the blocker. /waicc-limit ${phase} <limit> changes it explicitly; the overall limit still applies.`);
  if (taskId)
    ensure(
      v.contract.tasks.some((t) => t.id === taskId),
      "Unknown task ID",
    );
  if (mode === "implementation" || mode === "testing") readyContract(v.contract);
  if (wholeWork) ensure(!taskId, "Delegated work covers the whole plan, not a task/batch");
  if (review?.kind === "code" || wholeWork)
    ensure(
      v.requirementsDigest === digest(requirementsText(s)),
      "Requirements changed after the saved plan; revise the contract before completing work and requesting code review",
    );
  ensure(
    !review || mode === "review",
    "Review options only apply to review requests",
  );
  const source = snapshot(s.projectRoot);
  const firstCodeReview = s.rounds.find(
    (round) => round.review?.kind === "code",
  )?.review;
  const base = review?.kind === "code"
    ? firstCodeReview?.kind === "code"
      ? firstCodeReview.base
      : s.contractVersion > 1
        ? contract(s.projectRoot, s, 1).source
        : v.source
    : v.source;
  const reviewData = mode === "review"
    ? reviewContext(
        s,
        v.contract,
        source,
        base,
        review ?? { kind: "contract" },
        taskId,
      )
    : undefined;
  resetReview(s);
  if (mode === "review") s.contractReview = "PENDING";
  const round: Round = {
    id: randomUUID(),
    mode,
    phase,
    contractVersion: v.version,
    taskId: taskId ?? null,
    ...(advisor ? { advisor } : {}),
    ...(reviewData ? { review: reviewData } : {}),
    contextVersion: 1,
    checkpointVersion: 1,
    ...(wholeWork ? { wholeWork: true } : {}),
    source,
    requirementsDigest: digest(requirementsText(s)),
    status: "WAITING",
  };
  s.rounds.push(round);
  s.status =
    mode === "implementation" ? "READY_FOR_HANDOFF" : "WAITING_FOR_REPLY";
  const dir = roundDirectory(round);
  const instructions = handoff(s, round, v, focus);
  const context = contextPacket(s, round, v, focus,
    recall(s.projectRoot, `${requirementsText(s)}\n${focus}`), requirementsText(s));
  return {
    round,
    files: {
      [`${dir}/request.json`]: json({
        schemaVersion: 1,
        ...round,
        focus,
        projectRoot: s.projectRoot,
      }),
      [`${dir}/HANDOFF.md`]: instructions,
      [`${dir}/STARTER.txt`]: starterPrompt(s, round),
      [`${dir}/reply.example.json`]: json(replyTemplate(s, round, v)),
      [`${dir}/conversation.json`]: json(conversation(s, round)),
      ...Object.fromEntries(Object.entries(context).map(([name, content]) => [`${dir}/${name}`, content])),
      ...(reviewData?.kind === "code"
        ? { [`${dir}/code-review.json`]: json(reviewData) }
        : {}),
      ...skillFiles([...v.contract.skills, ...(["implementation", "testing"].includes(mode) ? ["wai-testing"] : [])], dir),
    },
  };
}
function newSession(root: string, requirements: string, implementationOwner?: "main" | "delegate", objective?: Objective,
  automatic?: { id: string; origin: NonNullable<Session["autoPlanning"]> }): Session {
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
function requireAcceptedPlan(root: string, s: Session): void {
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
export function prepare(
  cwd: string,
  id: string,
  value: unknown,
  mode: Mode,
  focus: string,
  expectedVersion: number,
  review?: ReviewRequest,
): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    ensure(
      s.contractVersion === expectedVersion,
      "Contract version changed; reload before preparing",
    );
    ensure(
      ["planning", "review"].includes(mode),
      "Prepare supports planning/review only; request advisor separately, or use assessment for implementation",
    );
    const c = validateContract(value, requirementsText(s));
    c.tasks
      .flatMap((t) => t.allowedPaths)
      .forEach((path) => safePath(root, path));
    if (s.contractVersion) stableIds(contract(root, s).contract, c);
    s.planApproval = null;
    s.contractVersion++;
    const files = contractFiles(s, c);
    const v = JSON.parse(
      files[`${versionDirectory(s.contractVersion)}/contract.json`],
    ) as ContractVersion;
    const next = nextRound(
      s, v, mode, text(focus, "Assignment focus"), undefined, undefined, review,
    );
    return commit(root, s, "handoff.prepared", { ...files, ...next.files });
  });
}
export function issue(
  cwd: string,
  id: string,
  mode: Mode,
  focus: string,
  taskId?: string,
  requirementIds?: string[],
  review?: ReviewRequest,
): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    if (mode === "implementation" || mode === "testing") {
      ensure(mode === "implementation" ? s.implementationOwner === "delegate" : s.testingOwner === "delegate",
        "Implementation handoffs require a ready assessment or explicit /waicc-help-develop choice; testing delegation requires /waicc-test");
      requireAcceptedPlan(root, s);
      if (s.objective) ensure(authorizationState(s, contract(root, s).contract).authorized, "No current development authorization; the human must /waicc-develop or /waicc-help-develop");
    }
    ensure(
      s.contractVersion > 0,
      "Prepare a contract before requesting advice or another handoff",
    );
    const next = nextRound(
      s,
      contract(root, s),
      mode,
      text(focus, "Assignment focus"),
      taskId,
      requirementIds,
      review,
      mode === "implementation" || mode === "testing",
    );
    return commit(root, s, "handoff.issued", next.files);
  });
}
export function ingest(cwd: string, id: string): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    if (s.status === "CLOSED") return s;
    const waiting = s.rounds.filter((r) => r.status === "WAITING");
    ensure(waiting.length <= 1, "Ambiguous pending requests");
    if (!waiting.length) {
      const received = s.rounds.findLast(
        (round) => round.status === "RECEIVED",
      );
      if (received) {
        const observed = JSON.parse(
          artifact(root, s, `${roundDirectory(received)}/observed-source.json`),
        ) as { fingerprint: string };
        if (snapshot(root).fingerprint !== observed.fingerprint) {
          received.status = "STALE";
          received.rationale =
            "Source changed after reply intake; issue a fresh request.";
          s.status = "STALE";
          if (received.mode === "review") s.contractReview = "STALE";
          return commit(root, s, "reply.became-stale");
        }
      }
      return s; // Idempotent resume of a received/assessed reply.
    }
    const r = waiting[0];
    const dir = roundDirectory(r);
    const path = safePath(root, `${sessionRelative(id)}/${dir}/reply.json`);
    if (!existsSync(path)) return s;
    const raw = readText(path, 256_000);
    const normalized = normalizeReply(JSON.parse(raw));
    const reply = validateRoundReply(root, s, r, normalized.reply);
    r.reply = reply;
    if (normalized.changes.length) r.replyNormalization = normalized.changes;
    r.replyDigest = digest(raw);
    const source = snapshot(root);
    const stale =
      r.requirementsDigest !== digest(requirementsText(s)) ||
      r.contractVersion !== s.contractVersion ||
      (r.mode !== "implementation" &&
        source.fingerprint !== r.source.fingerprint);
    r.status = stale ? "STALE" : "RECEIVED";
    if (stale)
      r.rationale =
        "The source, requirements or contract changed after this request was issued. The reply is retained as historical advice; issue a fresh request.";
    s.status = stale ? "STALE" : "AWAITING_ASSESSMENT";
    if (stale && r.mode === "review") s.contractReview = "STALE";
    return commit(root, s, stale ? "reply.stale" : "reply.received", {
      [`${dir}/received.json`]: raw,
      [`${dir}/observed-source.json`]: json(source),
      ...(normalized.changes.length
        ? {
            [`${dir}/received.normalized.json`]: json(reply),
            [`${dir}/reply-normalization.json`]: json({
              schemaVersion: 1,
              normalizerVersion: replyNormalizerVersion,
              changes: normalized.changes,
            }),
          }
        : {}),
    });
  });
}
/** The same identity, coverage and proposal rules apply to every reply transport. */
export function validateRoundReply(
  root: string,
  s: Session,
  r: Round,
  value: unknown,
): Reply {
  const reply = validateReply(normalizeReply(value).reply);
  ensure(
    reply.sessionId === s.id &&
      reply.requestId === r.id &&
      reply.contractVersion === r.contractVersion &&
      reply.mode === r.mode &&
      reply.sourceFingerprint === r.source.fingerprint &&
      reply.requirementsDigest === r.requirementsDigest,
    "Reply identity or pinned inputs do not match this request",
  );
  const v = contract(root, s, r.contractVersion);
  const ids =
    r.mode === "advisor"
      ? r.advisor!.requirementIds
      : v.contract.requirements.map((req) => req.id);
  ensure(
    reply.coverage.length === ids.length &&
      reply.coverage.every((row) => ids.includes(row.requirementId)),
    "Reply must cover every requirement in its assigned scope exactly once",
  );
  if (r.mode === "advisor")
    ensure(
      reply.advice!.question === r.advisor!.question,
      "Advisor question does not match this request",
    );
  if (reply.proposedContract) {
    try {
      validateContract(reply.proposedContract, requirementsText(s));
      stableIds(v.contract, reply.proposedContract);
    } catch (error) {
      // Name the failing part and show a valid shape, so a recipient fixes it in one pass.
      throw new Error(`proposedContract: ${error instanceof Error ? error.message : String(error)}. Every field is required except decisions; a valid example: ${JSON.stringify(proposedContractExample)}`);
    }
  }
  if (reply.completion) {
    const data = reviewContext(s, v.contract, r.source, r.source,
      { kind: "code", completion: reply.completion }, undefined, true);
    ensure(data.kind === "code", "Expected work completion evidence");
    reply.completion = data.completion;
    const checkClaims = (checks: Reply["checks"]) => checks.map(({ description, outcome, evidence }) => ({ description, outcome, evidence }));
    ensure(json(checkClaims(reply.completion.checks)) === json(checkClaims(reply.checks)),
      "Completion checks must match the reply checks; do not hide failed/not-run results");
  }
  if (r.mode === "implementation" && r.wholeWork && reply.outcome === "ready")
    ensure(reply.completion, "A completed delegated implementation needs completion evidence for ALL tasks and prior code-review findings");
  if (r.mode === "testing" && reply.outcome === "ready")
    ensure(reply.checks.some((check) => check.outcome === "passed"), "Testing readiness needs actual executed check evidence, not only not_run");
  return reply;
}
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
        ? (JSON.parse(
            files[`${versionDirectory(s.contractVersion)}/contract.json`],
          ) as ContractVersion)
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
        ? (JSON.parse(
            files[`${versionDirectory(s.contractVersion)}/contract.json`],
          ) as ContractVersion)
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
export function cancel(
  cwd: string,
  id: string,
  reason = "Cancelled by user.",
): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    const rationale = text(
      reason.trim() || "Cancelled by user.",
      "Cancellation reason",
    );
    const r = s.rounds.findLast((round) =>
      ["WAITING", "RECEIVED"].includes(round.status),
    );
    ensure(
      r,
      "There is no pending handoff to cancel. History is preserved; start /waicc-planning <requirements> for a new contract.",
    );
    r.status = "CANCELLED";
    r.rationale = rationale;
    s.status = "NEEDS_CHANGES";
    resetReview(s);
    return commit(root, s, "request.cancelled");
  });
}
export function amend(cwd: string, id: string, amendment: string): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    text(amendment, "Requirement amendment");
    s.requirements.push(amendment);
    s.planApproval = null;
    for (const r of s.rounds)
      if (["WAITING", "RECEIVED"].includes(r.status)) r.status = "STALE";
    s.status = "NEEDS_CHANGES";
    resetReview(s);
    return commit(root, s, "requirements.amended", {
      [`amendments/${s.requirements.length - 1}.md`]: `${amendment}\n`,
    });
  });
}
function closureFiles(s: Session, detail: string): Record<string, string> {
  ensure(s.closure, "Closure record is required");
  const dir = `lifecycle/${s.closure.id}`;
  return {
    [`${dir}/closure.json`]: json({
      schemaVersion: 1,
      sessionId: s.id,
      status: s.status,
      contractReview: s.contractReview,
      closure: s.closure,
      deliveryVerified: false,
      verified: false,
    }),
    [`${dir}/CLOSURE.md`]: `# CLOSED\n\n${s.closure.reason}\n\nClosure kind: ${s.closure.kind ?? "reviewed"}.\nContract v${s.contractVersion}; session ${s.id}.\nClosed at: ${s.closure.closedAt}.\n\n${detail}\n\nThis ends the contract discussion, not code delivery. Delivery verified: false.\n`,
  };
}
export function forceCloseSession(
  cwd: string,
  id: string,
  reason = "Force-closed by user.",
): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    const rationale = text(
      reason.trim() || "Force-closed by user.",
      "Force-closure reason",
    );
    if (s.status === "CLOSED") return s;
    const cancelledRequestIds: string[] = [];
    for (const r of s.rounds) {
      if (r.status === "WAITING" || r.status === "RECEIVED") {
        r.status = "CANCELLED";
        r.rationale = rationale;
        cancelledRequestIds.push(r.id);
      }
    }
    resetReview(s);
    s.closure = {
      kind: "forced",
      id: randomUUID(),
      closedAt: now(),
      reason: rationale,
      cancelledRequestIds,
    };
    s.status = "CLOSED";
    return commit(
      root,
      s,
      "contract.force-closed-by-explicit-command",
      closureFiles(
        s,
        `Force-closed without review approval. This is termination, not contract acceptance.\nContract review: NOT_REVIEWED. Pending handoffs cancelled: ${cancelledRequestIds.length}.`,
      ),
    );
  });
}
export function closeSession(cwd: string, id: string, reason: string): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    text(reason, "Closure reason");
    ensure(
      s.status === "READY_TO_CLOSE" || (s.status === "SPEC_APPROVED" && s.objective !== "development"),
      "Only a fresh reviewed objective in READY_TO_CLOSE (or planning-only SPEC_APPROVED) can be closed",
    );
    ensure(
      !s.rounds.some((r) => r.status === "WAITING" || r.status === "RECEIVED"),
      "Resolve pending replies before closing",
    );
    ensure(
      approvalIsCurrent(s, snapshot(root).fingerprint),
      "The passing review no longer matches the current contract, requirements or source. Request a fresh review.",
    );
    readyPlan(contract(root, s).contract);
    const round = s.rounds.at(-1)!;
    for (const file of [
      "assessment.json",
      "received.json",
      "observed-source.json",
      ...(round.review?.kind === "code" ? ["code-review.json"] : []),
      ...(round.contextVersion ? ["CONTEXT.md", "context.json", "memory.json", "conversation.json", "request.json"] : []),
      ...(round.checkpointVersion ? ["CHECKPOINT.md", "checkpoint.json"] : []),
      ...(round.replyNormalization?.length
        ? ["received.normalized.json", "reply-normalization.json"]
        : []),
    ])
      artifact(root, s, `${roundDirectory(round)}/${file}`);
    for (const path of Object.keys(s.artifacts).filter((path) => path.startsWith(`${roundDirectory(round)}/evidence/`)))
      artifact(root, s, path);
    s.closure = {
      kind: "reviewed",
      id: randomUUID(),
      closedAt: now(),
      reason,
      approval: { ...s.reviewApproval! },
    };
    s.status = "CLOSED";
    return commit(
      root,
      s,
      "contract.closed-by-explicit-command",
      closureFiles(s, `Contract review: PASS. Assessment request: ${round.id}.`),
    );
  });
}
export function reopenSession(
  cwd: string,
  id: string,
  reason: string,
): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    text(reason, "Reopening reason");
    ensure(
      s.status === "CLOSED" && s.closure,
      "Only a closed contract can be reopened",
    );
    const closure = s.closure;
    delete s.closure;
    delete s.implementationAuthorization;
    resetReview(s);
    s.status = "NEEDS_REVIEW";
    return commit(root, s, "contract.reopened-by-explicit-command", {
      [`lifecycle/${closure.id}/reopen.json`]: json({
        schemaVersion: 1,
        sessionId: id,
        closureId: closure.id,
        reopenedAt: now(),
        reason,
        contractVersion: s.contractVersion,
        requiresFreshReview: true,
        deliveryVerified: false,
      }),
    });
  });
}
export type SessionListFilter = "open" | "all" | "closed" | "deleted";
export function status(
  cwd: string,
  id?: string,
  filter: SessionListFilter = "open",
): unknown {
  const root = projectRoot(cwd);
  if (!id) {
    const sessions =
      filter === "deleted"
        ? listDeletedSessions(root)
        : listSessions(root).filter((s) =>
            filter === "all"
              ? true
              : filter === "closed"
                ? s.status === "CLOSED"
                : s.status !== "CLOSED",
          );
    const fingerprint = sessions.some((s) => ["READY_TO_CLOSE", "SPEC_APPROVED"].includes(s.status))
      ? snapshot(root).fingerprint
      : undefined;
    return {
      projectRoot: root,
      filter,
      sessions: sessions.map((s) =>
        ["READY_TO_CLOSE", "SPEC_APPROVED"].includes(s.status) &&
        !approvalIsCurrent(loadSession(root, s.id), fingerprint!)
          ? { ...s, status: "STALE", contractReview: "STALE" }
          : s,
      ),
    };
  }
  const s = loadSession(root, id);
  const currentSource = snapshot(root).fingerprint;
  const currentContract = s.contractVersion ? contract(root, s).contract : null;
  const authorization = authorizationState(s, currentContract);
  const planAccepted = acceptedPlanCurrent(root, s);
  const gates = currentContract ? decisionSummary(currentContract) : null;
  const staleApproval =
    ["READY_TO_CLOSE", "SPEC_APPROVED"].includes(s.status) &&
    !approvalIsCurrent(s, currentSource);
  const r = s.rounds.findLast(
    (round) => round.status === "WAITING" || round.status === "RECEIVED",
  );
  const last = s.rounds.findLast((round) => round.status === "ASSESSED");
  const lastReply = s.rounds.findLast((round) => round.reply);
  const replyExists = r
    ? existsSync(
        safePath(
          root,
          `${sessionRelative(s.id)}/${roundDirectory(r)}/reply.json`,
        ),
      )
    : false;
  return {
    sessionId: s.id,
    projectRoot: root,
    objective: s.objective ?? "legacy_unspecified",
    autoPlanning: s.autoPlanning ?? null,
    phase: sessionPhase(s),
    planApproval: s.planApproval ?? null,
    planAccepted,
    specificationReview: reviewState(s, "contract", currentSource),
    codeReview: reviewState(s, "code", currentSource),
    implementationAuthorized: authorization.authorized,
    implementationAuthorization: authorization,
    executionReady: authorization.authorized && gates?.openGates === 0 && planAccepted,
    openGates: gates?.openGates ?? 0,
    progress: progressState(root, s, currentContract, currentSource),
    roundBudget: roundUsage(s),
    decisionBriefPath: s.artifacts[`${versionDirectory(s.contractVersion)}/DECISIONS.md`]
      ? join(root, sessionRelative(s.id), versionDirectory(s.contractVersion), "DECISIONS.md") : null,
    // Keep delivery instructions ahead of potentially large requirements/contract previews.
    manualHandoff:
      r?.status === "WAITING" && !replyExists ? manualHandoff(s, r) : null,
    decisionGates: gates,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    status: staleApproval ? "STALE" : s.status,
    contractReview: staleApproval ? "STALE" : s.contractReview,
    reviewApproval: s.reviewApproval ?? null,
    implementationOwner: s.implementationOwner ?? "main",
    testingOwner: s.testingOwner ?? "main",
    coordinatorContext: s.context ?? null,
    checkpoint: s.checkpoint ? {
      ...s.checkpoint,
      checkpointPath: join(root, sessionRelative(s.id), s.checkpoint.markdownPath),
      indexPath: join(root, sessionRelative(s.id), s.checkpoint.jsonPath),
    } : null,
    reviewKind: reviewKindLabel(r ?? last),
    // Completion reports must not lose findings older than the bounded conversation preview.
    codeReviewFindings: s.rounds.flatMap((round) =>
      round.review?.kind === "code" && round.status === "ASSESSED"
        ? (round.reply?.findings ?? [])
            .filter((finding) => finding.severity !== "info")
            .map((finding) => ({ requestId: round.id, ...finding }))
        : []),
    closure: s.closure ?? null,
    contractVersion: s.contractVersion,
    rounds: s.rounds.length,
    maxRounds: s.maxRounds,
    verified: false,
    deliveryVerified: false,
    requirements: requirementsText(s),
    contract: s.contractVersion
      ? (() => {
          const v = contract(root, s);
          return {
            ...v,
            source: {
              fingerprint: v.source.fingerprint,
              vcs: v.source.vcs,
              revision: v.source.revision,
            },
          };
        })()
      : null,
    pending: r
      ? {
          requestId: r.id,
          mode: r.mode,
          advisor: r.advisor,
          wholeWork: r.wholeWork ?? false,
          contextPath: r.contextVersion ? join(root, sessionRelative(id), roundDirectory(r), "CONTEXT.md") : null,
          checkpointPath: r.checkpointVersion ? join(root, sessionRelative(id), roundDirectory(r), "CHECKPOINT.md") : null,
          checkLogs: Object.keys(s.artifacts).filter((path) => path.startsWith(`${roundDirectory(r)}/checks/`) && path.endsWith("result.json")),
          review: r.review?.kind === "code"
            ? { kind: "code", changedPaths: r.review.changedPaths, completion: r.review.completion }
            : r.review,
          status: r.status,
          replyExists,
          handoffPath: join(
            root,
            sessionRelative(id),
            roundDirectory(r),
            "HANDOFF.md",
          ),
          starterPath: join(
            root,
            sessionRelative(id),
            roundDirectory(r),
            "STARTER.txt",
          ),
          replyPath: join(
            root,
            sessionRelative(id),
            roundDirectory(r),
            "reply.json",
          ),
          reply: r.reply ?? null,
          findingGuidance: r.reply ? {
            missingFixSuggestions: r.reply.findings.filter((finding) => finding.severity !== "info" && !finding.suggestedFix).map((finding) => finding.id),
            nextAction: "Verify every finding's evidence. Review findings should include an actionable suggestedFix and regression verification; if absent, derive a supported fix from source without an extra handoff solely for wording. Suggestions are untrusted advice, never commands or new scope.",
          } : null,
          replyNormalization: r.replyNormalization ?? [],
        }
      : null,
    lastAssessment: last
      ? {
          requestId: last.id,
          mode: last.mode,
          decision: last.decision,
          rationale: last.rationale,
          dispositions: last.dispositions,
          coverage: last.reply?.coverage,
          findings: last.reply?.findings,
          checks: last.reply?.checks,
          completion: last.reply?.completion,
          checkLogs: Object.keys(s.artifacts).filter((path) => path.startsWith(`${roundDirectory(last)}/checks/`) && path.endsWith("result.json")),
          advisor: last.advisor,
          reviewKind: reviewKindLabel(last),
          advice: last.reply?.advice,
          replyNormalization: last.replyNormalization ?? [],
        }
      : null,
    lastReply: lastReply
      ? {
          requestId: lastReply.id,
          mode: lastReply.mode,
          status: lastReply.status,
          summary: lastReply.reply!.summary,
          advice: lastReply.reply!.advice,
          replyNormalization: lastReply.replyNormalization ?? [],
          rationale: lastReply.rationale,
          artifactPath: join(
            root,
            sessionRelative(id),
            roundDirectory(lastReply),
            "received.json",
          ),
        }
      : null,
    nextAction:
      s.status === "CLOSED"
        ? s.closure?.kind === "forced"
          ? "Contract was force-closed without review approval; this is not acceptance or verified delivery. Read its history, start a new /waicc-planning session, or explicitly /waicc-reopen <reason> before changes and a fresh review."
          : "Contract discussion is closed; delivery remains unverified. Read its history, or explicitly /waicc-reopen <reason> before changes and a fresh review."
        : staleApproval
          ? "The passing review is stale. Request a fresh full-contract review before closing."
          : s.status === "SPEC_APPROVED"
            ? "Specification PASS is not code completion or permission to build. Use /waicc-develop to accept this plan and authorize same-session development (main by default); inspect /waicc-decisions for gates. Planning-only work may instead be explicitly closed."
          : s.objective === "development" && !authorization.authorized && !r
            ? `${authorization.reason} Reconcile/accept amended requirements or the current plan first where needed; do not edit code or create another implementation handoff until authorized.`
          : ["READY_TO_IMPLEMENT", "IMPLEMENTATION_GATED"].includes(s.status)
            ? `${authorization.reason} ${authorization.authorized ? `Coding owner ${s.implementationOwner ?? "main"}. ${gates?.openGates ? "Use /waicc-decisions; main may do only genuinely unblocked authorized tasks. Whole-plan delegated coding and final review wait until all gates are resolved." : "Complete ALL work/checks before ONE full code review; delegation is optional."}` : "Stop implementation and obtain explicit /waicc-develop authorization."}`
          : s.status === "READY_TO_CLOSE"
            ? s.reviewApproval?.kind === "code"
              ? "Whole-change code review PASS. The human may /waicc-close <reason>; this is assessed evidence, not automatic delivery certification."
              : "Specification-only contract review PASS (legacy closure-ready state), NOT code approval or implementation authority. Use /waicc-develop to continue development in this SAME session, or explicitly close planning-only work."
            : s.status === "DRAFT"
              ? "Inspect the project and prepare a contract and handoff."
              : r?.status === "WAITING"
                ? replyExists
                  ? "A reply.json already exists. Return to the coordinator and /waicc-continue to validate it; do not send this request to another worker."
                  : "Manual handoff: copy manualHandoff.copyPastePrompt (or STARTER.txt CONTENTS) into one separate agent with project access. /waicc-handoff shows the copy block and return steps. After its reply, return here and /waicc-continue."
                : r?.status === "RECEIVED"
                  ? "Assess the received reply against the requirements and actual evidence."
                  : s.status === "ADVICE_READY"
                    ? "Discuss the recommendation with the human. Nothing was adopted or authorized; explicitly prepare a revision or request further advice/review as appropriate."
                    : s.status === "PLAN_READY"
                      ? `The plan is accepted. ${s.objective && !authorization.authorized ? "Implementation is NOT authorized. The human may /waicc-develop to extend this same session; no close/reopen/re-planning is needed." : s.implementationOwner === "delegate" ? "The selected implementation owner is delegate: the coordinator prepares ONE whole-work implementation handoff, not application edits itself." : "The main agent implements by default; /waicc-help-develop is optional delegation."} Finish ALL authorized tasks/fixes/checks before ONE full code review. No per-task/finding/batch handoffs. Keep real blockers gated. Planning-only scope stops here; --contract review remains explicit.`
                      : s.status === "NEEDS_TESTING"
                        ? "Implementation is reported complete but some checks were not run. The coordinator must inspect the diff and run required checks itself, or explicitly use /waicc-test. Do not treat missing verification as PASS; finish all fixes/checks before one full code review."
                      : s.status === "NEEDS_REVIEW"
                        ? "Finish ALL planned work and fixes, record completion/check evidence, then request ONE whole-change /waicc-review."
                        : s.status === "READY_FOR_HANDOFF"
                          ? "The reviewed artifact is ready for its next human-chosen handoff; delivery remains unverified."
                          : (last?.review?.kind === "code" || last?.wholeWork) &&
                            ["NEEDS_CHANGES", "BLOCKED"].includes(s.status)
                            ? "The main agent must address ALL code-review findings, implementation gaps or test failures (or delegate one complete fix cycle if implementationOwner is delegate). Finish all planned work/checks before one fresh whole-change review. No per-finding/task/batch handoffs. Preserve genuine blockers."
                            : s.rounds.at(-1)?.mode === "advisor"
                              ? "Resolve the advice blocker or ask /waicc-advisor with a clarified question. Contract changes require a separate explicit human decision."
                              : "Resolve the reported blocker or issue a fresh request.",
  };
}
export function exportHandoff(cwd: string, id: string): string {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    const r = s.rounds.findLast((round) => round.status === "WAITING");
    ensure(r, "No pending handoff to export");
    const v = contract(root, s, r.contractVersion);
    const exportId = randomUUID();
    const request = JSON.parse(
      artifact(root, s, `${roundDirectory(r)}/request.json`),
    ) as { focus: string };
    const dir = `exports/${exportId}`;
    const files: Record<string, string> = {
      [`${dir}/requirements.md`]: requirementsText(s),
      [`${dir}/contract.json`]: json(v),
      [`${dir}/CONTRACT.md`]: contractMarkdown(v),
      [`${dir}/HANDOFF.md`]: handoff(s, r, v, request.focus, true),
      [`${dir}/STARTER.txt`]: starterPrompt(s, r, true),
      [`${dir}/reply.example.json`]: json(replyTemplate(s, r, v)),
      [`${dir}/conversation.json`]: json(conversation(s, r)),
      ...(r.review?.kind === "code"
        ? { [`${dir}/code-review.json`]: artifact(root, s, `${roundDirectory(r)}/code-review.json`) }
        : {}),
      ...(r.contextVersion
        ? Object.fromEntries(["CONTEXT.md", "context.json", "memory.json"].map((name) =>
            [`${dir}/${name}`, artifact(root, s, `${roundDirectory(r)}/${name}`)]))
        : r.mode === "advisor"
        ? {
            [`${dir}/memory.json`]: artifact(
              root,
              s,
              `${roundDirectory(r)}/memory.json`,
            ),
          }
        : {}),
      ...(r.checkpointVersion ? {
        [`${dir}/CHECKPOINT.md`]: artifact(root, s, `${roundDirectory(r)}/CHECKPOINT.md`),
        [`${dir}/checkpoint.json`]: artifact(root, s, `${roundDirectory(r)}/checkpoint.json`),
        ...Object.fromEntries((JSON.parse(artifact(root, s, `${roundDirectory(r)}/checkpoint.json`)) as ReturnType<typeof checkpointData>).artifacts
          .map((ref) => [`${dir}/archive/${ref.path}`, artifact(root, s, ref.path)])),
      } : {}),
      ...Object.fromEntries(Object.keys(s.artifacts).filter((path) => path.startsWith(`${roundDirectory(r)}/evidence/`))
        .map((path) => [`${dir}/${path.slice(`${roundDirectory(r)}/`.length)}`, artifact(root, s, path)])),
      [`${dir}/manifest.json`]: json({
        schemaVersion: 1,
        sessionId: id,
        requestId: r.id,
        contractVersion: v.version,
        mode: r.mode,
        advisor: r.advisor,
        reviewKind: r.review?.kind,
        source: r.source,
        includesSourceCode: false,
        checkpointArtifactBase: r.checkpointVersion ? "archive/" : null,
        returnReplyTo: join(
          root,
          sessionRelative(id),
          roundDirectory(r),
          "reply.json",
        ),
      }),
      ...skillFiles([...v.contract.skills, ...(["implementation", "testing"].includes(r.mode) ? ["wai-testing"] : [])], dir),
    };
    commit(root, s, "handoff.exported", files);
    return join(root, sessionRelative(id), dir);
  });
}
export function setRoundLimit(cwd: string, id: string, limit: number, phase?: RoundPhase): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    requireOpen(s);
    if (phase) {
      ensure(Object.hasOwn(defaultRoundLimits, phase), "Unknown round phase");
      const used = s.rounds.filter((r) => (r.phase ?? roundPhase(r.mode, r.review?.kind)) === phase).length;
      ensure(Number.isInteger(limit) && limit >= Math.max(2, used) && limit <= 20, "Phase limit must be between its used count (at least 2) and 20");
      s.roundLimits = { ...s.roundLimits, [phase]: limit };
      return commit(root, s, "phase-round-limit.changed-by-human");
    }
    ensure(
      Number.isInteger(limit) &&
        limit >= Math.max(2, s.rounds.length) &&
        limit <= 20,
      "Round limit must be between current round count (at least 2) and 20",
    );
    s.maxRounds = limit;
    return commit(root, s, "round-limit.changed-by-human");
  });
}
