import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { artifact, digest, json, loadSession, now, readText, safePath, storedJson, withSnapshots } from "../files.ts";
import { contractMarkdown, conversation, handoff, replyTemplate, roundDirectory, starterPrompt, versionDirectory } from "../render.ts";
import { projectRoot, snapshot } from "../source.ts";
import { recall } from "../memory.ts";
import { decisionBrief } from "../decisions.ts";
import { revisionChanges } from "../revision.ts";
import { reviewContext, type ReviewRequest } from "../review.ts";
import { contextPacket } from "../context.ts";
import { requirementsText, roundPhase } from "../state.ts";
import { ensure, identifier, list, readyContract } from "../validation.ts";
import type { Contract, ContractVersion, Mode, Round, Session } from "../types.ts";

/** Helpers every workflow step uses: open-session checks, contract files and versions, skills and new rounds. */

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export function requireOpen(s: Session): void {
  ensure(
    s.status !== "CLOSED",
    "Contract is closed. Use /waicc-reopen <reason> before changing it.",
  );
}
export function resetReview(s: Session): void {
  s.contractReview = "NOT_REVIEWED";
  delete s.reviewApproval;
}
export function approvalIsCurrent(s: Session, sourceFingerprint: string): boolean {
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
export function contract(
  root: string,
  s: Session,
  version = s.contractVersion,
): ContractVersion {
  return parsedContract(root, s, artifact(root, s, `${versionDirectory(version)}/contract.json`));
}
/** A contract.json as written, with its source snapshot's files back: a first code review's baseline. */
export const parsedContract = (root: string, s: Session, text: string): ContractVersion =>
  withSnapshots(root, s.id, JSON.parse(text) as ContractVersion);
export function readContract(cwd: string, id: string): ContractVersion {
  const root = projectRoot(cwd);
  return contract(root, loadSession(root, id));
}
export function contractFiles(
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
    [`${versionDirectory(v.version)}/contract.json`]: storedJson(s.projectRoot, s.id, v),
    [`${versionDirectory(v.version)}/CONTRACT.md`]: contractMarkdown(v),
    [`${versionDirectory(v.version)}/DECISIONS.md`]: `Contract v${v.version}; session ${s.id}.\n\n${decisionBrief(c)}`,
  };
}
export function stableIds(previous: Contract, next: Contract): void {
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
export function skillFiles(names: string[], prefix: string): Record<string, string> {
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
export function nextRound(
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
  let reviewData = mode === "review"
    ? reviewContext(
        s,
        v.contract,
        source,
        base,
        review ?? { kind: "contract" },
        taskId,
      )
    : undefined;
  // A review of an existing change carries that change, and any fixes made since, every round.
  const revision = reviewData?.kind === "code" && s.revisionReview ? revisionChanges(s.projectRoot, s.revisionReview) : undefined;
  if (revision && reviewData?.kind === "code")
    reviewData = {
      ...reviewData,
      changedPaths: [...new Set([...revision.changedPaths, ...reviewData.changedPaths])].sort(),
      revision: {
        ...s.revisionReview!, changedPaths: revision.changedPaths, truncated: revision.truncated, patchBytes: revision.patchBytes, checkout: source.revision,
        ...(revision.parts.length ? { parts: revision.parts.map(({ patch: _patch, ...part }) => part) } : {}),
      },
    };
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
      [`${dir}/request.json`]: storedJson(s.projectRoot, s.id, {
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
        ? { [`${dir}/code-review.json`]: storedJson(s.projectRoot, s.id, reviewData) }
        : {}),
      ...(revision ? { [`${dir}/changes.patch`]: revision.patch, [`${dir}/commits.txt`]: revision.commits } : {}),
      ...Object.fromEntries((revision?.parts ?? []).map((part) => [`${dir}/changes/${part.file}`, part.patch])),
      ...skillFiles([...v.contract.skills, ...(["implementation", "testing"].includes(mode) ? ["wai-testing"] : [])], dir),
    },
  };
}
