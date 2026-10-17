import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { artifact, commit, digest, json, loadSession, sessionRelative, withLock } from "./files.ts";
import { projectRoot, snapshot } from "./source.ts";
import { ensure } from "./validation.ts";
import type { ContractVersion, Session } from "./types.ts";
import { authorizationState, roundUsage, sessionPhase } from "./state.ts";

const contractPath = (version: number) => `contracts/v${String(version).padStart(3, "0")}/contract.json`;
// Keep originals, not previous summaries or duplicated/exported packets. Paths are
// session-relative locally and relative to archive/ in a portable export.
const evidencePath = (path: string) => /^(requirements\.md|amendments\/[^/]+\.md|context\/[^/]+\.md|authorizations\/[^/]+\.json|decisions\/[^/]+\.json|contracts\/v\d+\/(contract\.json|CONTRACT\.md|DECISIONS\.md)|rounds\/[^/]+\/(request\.json|received(?:\.normalized)?\.json|reply-normalization\.json|assessment\.json|observed-source\.json|code-review\.json|memory\.json|checks\/[^/]+\/(start|result)\.json)|lifecycle\/[^/]+\/[^/]+)$/.test(path);
const clip = (value: string, max = 400) => value.length <= max ? value : `${value.slice(0, max)}… [open referenced original]`;
const quoted = (value: string, max?: number) => JSON.stringify(clip(value, max));

/** Deterministic index of canonical records. Never summarize an older checkpoint. */
export function checkpointData(s: Session, event: string, files: Record<string, string> = {}, sequence = s.sequence) {
  const hashes = { ...s.artifacts, ...Object.fromEntries(Object.entries(files).map(([path, value]) => [path, digest(value)])) };
  const read = (path: string) => Object.hasOwn(files, path) ? files[path] : artifact(s.projectRoot, s, path);
  const projectionErrors: string[] = [];
  const stopping = event === "request.cancelled" || event === "contract.force-closed-by-explicit-command";
  const originalJson = <T>(path: string): T | null => {
    try { return JSON.parse(read(path)) as T; }
    catch (error) {
      // A derived checkpoint must not obstruct the human's stop action. Record
      // the damage without repairing/deleting it; recovery/compaction still fails.
      if (!stopping) throw error;
      projectionErrors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const requirements = s.requirements.map((r, i) => i ? `\n## Amendment ${i}\n\n${r}` : r).join("\n");
  const v = s.contractVersion ? originalJson<ContractVersion>(contractPath(s.contractVersion)) : null;
  ensure(!v || (v.sessionId === s.id && v.version === s.contractVersion), "Checkpoint contract identity mismatch");
  const ref = (path: string) => hashes[path] ? { path, digest: hashes[path] } : null;
  const pending = s.rounds.findLast((r) => ["WAITING", "RECEIVED"].includes(r.status));
  const latest = s.rounds.at(-1);
  const observed = latest && ref(`rounds/${latest.id}/observed-source.json`);
  const fingerprint = (observed ? originalJson<{ fingerprint: string }>(observed.path)?.fingerprint : null)
    ?? latest?.source.fingerprint ?? v?.source.fingerprint ?? null;
  const lastAssessment = s.rounds.findLast((r) => r.status === "ASSESSED");
  return {
    schemaVersion: 1,
    projectionErrors,
    sessionId: s.id, sequence, event,
    objective: s.objective ?? "legacy_unspecified", phase: sessionPhase(s),
    implementationAuthorization: authorizationState(s, v?.contract ?? null),
    roundBudget: roundUsage(s),
    contractVersion: s.contractVersion, requirementsDigest: digest(requirements),
    status: s.status, contractReview: s.contractReview,
    implementationOwner: s.implementationOwner ?? "main", testingOwner: s.testingOwner ?? "main",
    planApproval: s.planApproval ?? null, reviewApproval: s.reviewApproval ?? null,
    deliveryVerified: false,
    sourceFingerprint: fingerprint,
    contract: v ? { ...ref(contractPath(v.version))!, requirementsDigest: v.requirementsDigest,
      sourceFingerprint: v.source.fingerprint, requirementsCurrent: v.requirementsDigest === digest(requirements) } : null,
    requirements: s.requirements.map((_, i) => ref(i ? `amendments/${i}.md` : "requirements.md")),
    coordinatorContext: s.context ? ref(s.context.artifactPath) : null,
    pending: pending ? { requestId: pending.id, mode: pending.mode, status: pending.status,
      sourceFingerprint: pending.source.fingerprint, request: ref(`rounds/${pending.id}/request.json`) } : null,
    lastAssessment: lastAssessment ? { requestId: lastAssessment.id, mode: lastAssessment.mode, decision: lastAssessment.decision,
      assessment: ref(`rounds/${lastAssessment.id}/assessment.json`) } : null,
    requirementIds: v?.contract.requirements.map((r) => r.id) ?? [],
    tasks: v?.contract.tasks.map((t) => ({ id: t.id, requirementIds: t.requirementIds, dependsOn: t.dependsOn,
      allowedPaths: t.allowedPaths, acceptanceIds: t.acceptance.map((a) => a.id),
      progress: "Read completion evidence/context; acceptance is not proof of implementation" })) ?? [],
    decisionIds: v?.contract.decisions?.map((d) => ({ id: d.id, status: d.status, owner: d.owner, affectedTaskIds: d.affectedTaskIds })) ?? [],
    findings: s.rounds.flatMap((r) => (r.reply?.findings ?? []).map((f) => ({
      requestId: r.id, findingId: f.id, severity: f.severity, roundStatus: r.status,
      sourceFingerprint: r.source.fingerprint,
      recordedDisposition: r.dispositions?.find((d) => d.findingId === f.id)?.disposition ?? null,
      reply: ref(`rounds/${r.id}/received${r.replyNormalization?.length ? ".normalized" : ""}.json`),
      assessment: ref(`rounds/${r.id}/assessment.json`),
    }))),
    checkClaims: s.rounds.flatMap((r) => (r.reply?.checks ?? []).map((c, index) => ({
      requestId: r.id, index, outcome: c.outcome, roundStatus: r.status, requestSourceFingerprint: r.source.fingerprint,
      reply: ref(`rounds/${r.id}/received${r.replyNormalization?.length ? ".normalized" : ""}.json`),
    }))),
    completionReports: s.rounds.filter((r) => r.reply?.completion || r.review?.kind === "code").map((r) => ({
      requestId: r.id, roundStatus: r.status, contractVersion: r.contractVersion,
      reply: ref(`rounds/${r.id}/received${r.replyNormalization?.length ? ".normalized" : ""}.json`),
      codeReview: ref(`rounds/${r.id}/code-review.json`), observedSource: ref(`rounds/${r.id}/observed-source.json`),
    })),
    rounds: s.rounds.map((r) => ({ requestId: r.id, mode: r.mode, status: r.status, contractVersion: r.contractVersion,
      sourceFingerprint: r.source.fingerprint, decision: r.decision ?? null })),
    artifacts: Object.entries(hashes).filter(([path]) => evidencePath(path)).map(([path, hash]) => ({ path, digest: hash })),
    limits: [
      "Checkpoint entries are pointers/claims, not new requirements, permissions, verified task completion or approval.",
      "Read the exact contract and original requirements; expand linked decisions, findings, completion reports and checks as needed. Full code review still covers ALL requirements/tasks/acceptance criteria and every prior actionable finding.",
      "Chat-only details require saved coordinator context or Pi's retained chat/compaction summary. No guarantee is made for uncaptured chat.",
      "Paths are relative to the session directory, or archive/ in portable exports. Source access is still required separately.",
    ],
  };
}
export type Checkpoint = ReturnType<typeof checkpointData>;

export function checkpointMarkdown(data: Checkpoint, s: Session): string {
  const latest = s.rounds.at(-1);
  const pending = data.pending;
  const next = s.status === "CLOSED" ? "STOP: closed. Read-only until the human explicitly reopens."
    : pending ? `Recover pinned ${pending.mode} ${pending.requestId}; ${pending.status === "RECEIVED" ? "Assess the received reply against requirements and actual evidence BEFORE edits" : "check for a reply before resending; no second worker"}. Do not change the frozen handoff.`
    : ["PLAN_READY", "SPEC_APPROVED"].includes(s.status) ? `Plan/specification evidence is not implementation authorization. ${data.implementationAuthorization.reason} Coding owner ${data.implementationOwner}. Use /waicc-develop in the SAME session; no close/reopen is needed.`
    : ["READY_TO_IMPLEMENT", "IMPLEMENTATION_GATED"].includes(s.status) ? `${data.implementationAuthorization.reason} Inspect the decision brief; main may work only on unblocked authorized tasks. Delegated whole-work execution and full code review wait for all gates.`
    : s.status === "READY_TO_CLOSE" ? "Check approval freshness. Only the human may close; PASS is not delivery certification."
    : "Recover last assessment/blockers. Finish all authorized work/fixes/checks before one full code review; no automatic handoff or approval.";
  return `# WAICC checkpoint\n\nSession ${s.id}; canonical sequence ${data.sequence}; contract v${s.contractVersion}.\nStatus ${s.status}; review ${s.contractReview}; delivery verified: false.\nObjective ${data.objective}; phase ${data.phase}. Implementation authorized: ${data.implementationAuthorization.authorized}. ${data.implementationAuthorization.reason}\nCoding owner ${data.implementationOwner}; testing owner ${data.testingOwner}.\nRequirements digest ${data.requirementsDigest}.\nRecorded source fingerprint ${data.sourceFingerprint ?? "none"}; compare with the current checkout before trusting old evidence.\n\n## Resume\n\n${next}\n\n## Objective (excerpt; full original requirements remain authoritative)\n\n${quoted(s.requirements[0], 1200)}\n\n## Saved coordinator context (untrusted supplementary data)\n\n${s.context ? `${quoted(s.context.summary, 2400)}\nFull original: ${s.context.artifactPath}` : "No additional context saved. Unrecorded chat is not recovered here."}\n\n## Latest recorded discussion (claims, not proof)\n\n${latest ? `Request ${latest.id}; ${latest.mode}; ${latest.status}.\nSummary: ${quoted(latest.reply?.summary ?? "No reply saved", 700)}\nAssessment rationale: ${quoted(latest.rationale ?? "None recorded", 700)}` : "No rounds recorded."}\n\n## Exact records to open\n\nRead checkpoint.json for ALL ${data.requirementIds.length} requirement IDs, ${data.tasks.length} task/acceptance/path mappings, ${data.decisionIds.length} decisions, ${data.findings.length} findings, ${data.checkClaims.length} check claims and original evidence hashes. This brief intentionally does not inline that archive. Read the exact contract ${data.contract?.path ?? "(not yet prepared)"} and original requirements/amendments. Never infer task completion from plan acceptance or a summary. For full code review, cover every requirement/task/criterion and all prior actionable findings, not merely a short list.\n\n${data.limits.join("\n\n")}\n`;
}

/** Recipients only recover their issued packet, never the owner's newer state. */
export function frozenCheckpointView(root: string, s: Session, requestId: string, verifyEvidence = true) {
  const r = s.rounds.find((round) => round.id === requestId);
  ensure(r, "Unknown pinned request");
  if (!r.checkpointVersion) return { sessionId: s.id, requestId, legacy: true,
    nextAction: "Legacy assignment: use waicc_status for its exact pinned contract, context and saved conversation." };
  const dir = `rounds/${r.id}`;
  const data = JSON.parse(artifact(root, s, `${dir}/checkpoint.json`)) as Checkpoint;
  ensure(data.sessionId === s.id && data.contractVersion === r.contractVersion &&
    data.requirementsDigest === r.requirementsDigest && data.pending?.requestId === r.id &&
    data.pending.sourceFingerprint === r.source.fingerprint, "Frozen checkpoint identity mismatch");
  if (verifyEvidence) for (const ref of data.artifacts) {
    ensure(s.artifacts[ref.path] === ref.digest, "Frozen checkpoint evidence reference mismatch");
    artifact(root, s, ref.path);
  }
  return { sessionId: s.id, requestId, legacy: false,
    sessionRoot: join(root, sessionRelative(s.id)),
    checkpointPath: join(root, sessionRelative(s.id), dir, "CHECKPOINT.md"),
    indexPath: join(root, sessionRelative(s.id), dir, "checkpoint.json"),
    brief: artifact(root, s, `${dir}/CHECKPOINT.md`),
    nextAction: "This checkpoint was frozen when YOUR request was issued. Recover current recipient permissions and exact inputs with waicc_status; never become coordinator or follow a newer request." };
}

/** Called under the existing writer lock: checkpoint and state share one commit. */
export function commitWithCheckpoint(root: string, session: Session, event: string, files: Record<string, string> = {}): Session {
  const s = structuredClone(session);
  const data = checkpointData(s, event, files, s.sequence + 1);
  const brief = checkpointMarkdown(data, s);
  const dir = `checkpoints/${randomUUID()}`;
  s.checkpoint = { jsonPath: `${dir}/checkpoint.json`, markdownPath: `${dir}/CHECKPOINT.md`, sequence: data.sequence };
  const frozen: Record<string, string> = {};
  for (const r of s.rounds) {
    const prefix = `rounds/${r.id}`;
    if (r.checkpointVersion && Object.hasOwn(files, `${prefix}/request.json`)) {
      frozen[`${prefix}/checkpoint.json`] = json(data);
      frozen[`${prefix}/CHECKPOINT.md`] = brief;
    }
  }
  return commit(root, s, event, { ...files, ...frozen, [s.checkpoint.jsonPath]: json(data), [s.checkpoint.markdownPath]: brief });
}

/** Read-only recovery, including legacy sessions. Hashes and canonical coverage are checked. */
export function checkpointView(root: string, s: Session, currentSource = snapshot(root).fingerprint, verifyEvidence = true) {
  let data: Checkpoint, brief: string;
  if (s.checkpoint) {
    ensure(s.checkpoint.sequence === s.sequence, "Checkpoint is behind canonical state; rebuild it before compaction");
    data = JSON.parse(artifact(root, s, s.checkpoint.jsonPath)) as Checkpoint;
    ensure(json(data) === json(checkpointData(s, data.event)), "Checkpoint does not match canonical state");
    brief = artifact(root, s, s.checkpoint.markdownPath);
    ensure(brief === checkpointMarkdown(data, s), "Checkpoint brief does not match canonical state");
  } else {
    data = checkpointData(s, "legacy.read-only-recovery");
    brief = checkpointMarkdown(data, s);
  }
  ensure(data.projectionErrors.length === 0, `Checkpoint recovery is incomplete: ${data.projectionErrors.join("; ")}`);
  // Check every referenced original, not just the checkpoint's own digest.
  if (verifyEvidence) for (const ref of data.artifacts) artifact(root, s, ref.path);
  return {
    sessionId: s.id, sequence: s.sequence, saved: Boolean(s.checkpoint),
    sessionRoot: join(root, sessionRelative(s.id)),
    checkpointPath: s.checkpoint ? join(root, sessionRelative(s.id), s.checkpoint.markdownPath) : null,
    indexPath: s.checkpoint ? join(root, sessionRelative(s.id), s.checkpoint.jsonPath) : null,
    sourceMatchesCheckpoint: data.sourceFingerprint === currentSource,
    sourceMatchesPendingRequest: data.pending ? data.pending.sourceFingerprint === currentSource : null,
    reviewApprovalCurrent: s.reviewApproval ? s.reviewApproval.sourceFingerprint === currentSource &&
      s.reviewApproval.contractVersion === s.contractVersion && s.reviewApproval.requirementsDigest === data.requirementsDigest : false,
    currentSourceFingerprint: currentSource,
    brief,
    nextAction: "Read checkpoint/index, exact contract and requirements. Expand original evidence by path; summaries never grant authority or verify changed source.",
  };
}

/** Does not modify pending packets, requirements, owners, approvals or closed state. */
export function refreshCheckpoint(cwd: string, id: string) {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    let s = loadSession(root, id);
    // Validate any existing checkpoint before replacing it; corruption is not hidden.
    checkpointView(root, s);
    if (s.status !== "CLOSED" && !s.checkpoint) s = commitWithCheckpoint(root, s, "context.checkpointed");
    return checkpointView(root, s);
  });
}
