import { randomUUID } from "node:crypto";
import { artifact, json, loadSession, now, withLock } from "../files.ts";
import { roundDirectory } from "../render.ts";
import { projectRoot, snapshot } from "../source.ts";
import { commitWithCheckpoint as commit } from "../checkpoint.ts";
import { ensure, text, readyPlan } from "../validation.ts";
import { acceptedFindings } from "../state.ts";
import type { Session, Shipped } from "../types.ts";
import { requireOpen, resetReview, approvalIsCurrent, contract } from "./shared.ts";

/** Cancelling, amending, closing, force-closing and reopening a session. */

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
  const accepted = acceptedFindings(s);
  const left = accepted.length
    ? `\n\n## Findings accepted unfixed\n\n${accepted.map((f) => `- ${f.findingId} (${f.severity}): ${f.description} Reason: ${f.reason}`).join("\n")}`
    : "";
  return {
    [`${dir}/closure.json`]: json({
      schemaVersion: 1,
      sessionId: s.id,
      status: s.status,
      contractReview: s.contractReview,
      closure: s.closure,
      acceptedFindings: accepted,
      deliveryVerified: false,
      verified: false,
    }),
    [`${dir}/CLOSURE.md`]: `# CLOSED\n\n${s.closure.reason}\n\nClosure kind: ${s.closure.kind ?? "reviewed"}.\nContract v${s.contractVersion}; session ${s.id}.\nClosed at: ${s.closure.closedAt}.\n\n${detail}${left}\n\nThis ends the contract discussion, not code delivery. Delivery verified: false.\n`,
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
/** /waicc-ship, after the push: the session is closed with where the change went. */
export function closeShipped(cwd: string, id: string, shipped: Shipped): Session {
  return closeSession(cwd, id, `Shipped as ${shipped.request.url ?? `branch ${shipped.branch}`} (${shipped.commit.slice(0, 10)} on ${shipped.remote}/${shipped.branch}, into ${shipped.target}).`, shipped);
}
export function closeSession(cwd: string, id: string, reason: string, shipped?: Shipped): Session {
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
      // Shipping committed the reviewed files, which changes Git's state: it checked the source just before.
      approvalIsCurrent(s, shipped ? shipped.reviewedFingerprint : snapshot(root).fingerprint),
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
    if (shipped) s.shipped = shipped;
    return commit(
      root,
      s,
      shipped ? "contract.shipped" : "contract.closed-by-explicit-command",
      {
        ...closureFiles(s, `Contract review: PASS. Assessment request: ${round.id}.${shipped ? `\nShipped: ${shipped.request.url ?? shipped.branch}.` : ""}`),
        ...(shipped ? { [`lifecycle/${s.closure.id}/ship.json`]: json(shipped) } : {}),
      },
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
