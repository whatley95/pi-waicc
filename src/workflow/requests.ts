import { existsSync } from "node:fs";
import { artifact, digest, json, loadSession, readText, safePath, sessionRelative, storedJson, withLock } from "../files.ts";
import { roundDirectory, proposedContractExample, versionDirectory } from "../render.ts";
import { projectRoot, snapshot } from "../source.ts";
import { normalizeReply, replyNormalizerVersion } from "../reply.ts";
import { reviewContext, type ReviewRequest } from "../review.ts";
import { commitWithCheckpoint as commit } from "../checkpoint.ts";
import { authorizationState, requirementsText } from "../state.ts";
import { Collector, ensure, text, validateContract, validateReply } from "../validation.ts";
import type { ContractVersion, Mode, Reply, Round, Session } from "../types.ts";
import { requireOpen, contract, contractFiles, parsedContract, stableIds, nextRound } from "./shared.ts";
import { requireAcceptedPlan } from "./sessions.ts";

/** Preparing and issuing handoffs, and taking in and validating their replies. */

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
    const v = parsedContract(root, s, files[`${versionDirectory(s.contractVersion)}/contract.json`]);
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
      [`${dir}/observed-source.json`]: storedJson(root, s.id, source),
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
  // Independent problems are reported together, so a recipient fixes them in one pass.
  const problems = new Collector();
  problems.check("coverage", () => ensure(
    reply.coverage.length === ids.length &&
      reply.coverage.every((row) => ids.includes(row.requirementId)),
    "Reply must cover every requirement in its assigned scope exactly once",
  ));
  if (r.mode === "advisor")
    problems.check("advice.question", () => ensure(
      reply.advice!.question === r.advisor!.question,
      "Advisor question does not match this request",
    ));
  const proposal = reply.proposedContract && problems.check("proposedContract", () => {
    validateContract(reply.proposedContract, requirementsText(s));
    stableIds(v.contract, reply.proposedContract!);
    return true;
  }) === undefined;
  if (reply.completion)
    problems.check("completion", () => {
      const data = reviewContext(s, v.contract, r.source, r.source,
        { kind: "code", completion: reply.completion! }, undefined, true);
      ensure(data.kind === "code", "Expected work completion evidence");
      reply.completion = data.completion;
      const checkClaims = (checks: Reply["checks"]) => checks.map(({ description, outcome, evidence }) => ({ description, outcome, evidence }));
      ensure(json(checkClaims(reply.completion.checks)) === json(checkClaims(reply.checks)),
        "Completion checks must match the reply checks; do not hide failed/not-run results");
    });
  if (r.mode === "implementation" && r.wholeWork && reply.outcome === "ready")
    problems.check("completion", () => ensure(reply.completion, "A completed delegated implementation needs completion evidence for ALL tasks and prior code-review findings"));
  if (r.mode === "testing" && reply.outcome === "ready")
    problems.check("checks", () => ensure(reply.checks.some((check) => check.outcome === "passed"), "Testing readiness needs actual executed check evidence, not only not_run"));
  // With a broken proposal, show a valid shape too.
  problems.done(proposal ? `\nEvery proposedContract field is required except decisions; a valid example: ${JSON.stringify(proposedContractExample)}` : "");
  return reply;
}
