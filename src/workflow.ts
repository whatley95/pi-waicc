import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifact,
  commit,
  digest,
  json,
  listSessions,
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
  replyTemplate,
  roundDirectory,
  versionDirectory,
} from "./render.ts";
import { projectRoot, snapshot } from "./source.ts";
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
} from "./validation.ts";
import type {
  Contract,
  ContractVersion,
  Mode,
  Round,
  Session,
} from "./types.ts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const requirementsText = (s: Session): string =>
  s.requirements
    .map((r, i) => (i ? `\n## Amendment ${i}\n\n${r}` : r))
    .join("\n");
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
): { round: Round; files: Record<string, string> } {
  ensure(
    !s.rounds.some((r) => r.status === "WAITING" || r.status === "RECEIVED"),
    "Assess or explicitly cancel the pending request before issuing another",
  );
  ensure(
    s.rounds.length < s.maxRounds,
    `Session reached its ${s.maxRounds}-round limit. Stop and resolve the blocker; adjust the limit explicitly if justified.`,
  );
  if (taskId)
    ensure(
      v.contract.tasks.some((t) => t.id === taskId),
      "Unknown task ID",
    );
  if (mode === "implementation") readyContract(v.contract);
  const round: Round = {
    id: randomUUID(),
    mode,
    contractVersion: v.version,
    taskId: taskId ?? null,
    source: snapshot(s.projectRoot),
    requirementsDigest: digest(requirementsText(s)),
    status: "WAITING",
  };
  s.rounds.push(round);
  s.status =
    mode === "implementation" ? "READY_FOR_HANDOFF" : "WAITING_FOR_REPLY";
  const dir = roundDirectory(round);
  const instructions = handoff(s, round, v, focus);
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
      [`${dir}/STARTER.txt`]: `Read ${join(s.projectRoot, sessionRelative(s.id), dir, "HANDOFF.md")} and perform its ${mode} assignment. Write the designated reply.\n`,
      [`${dir}/reply.example.json`]: json(replyTemplate(s, round, v)),
      [`${dir}/conversation.json`]: json(conversation(s, round)),
      ...skillFiles(v.contract.skills, dir),
    },
  };
}
export function createSession(cwd: string, requirements: string): Session {
  const root = projectRoot(cwd);
  text(requirements, "Original requirements", 64_000);
  return withLock(root, () => {
    const s: Session = {
      schemaVersion: 1,
      id: randomUUID(),
      projectRoot: root,
      createdAt: now(),
      sequence: 0,
      requirements: [requirements],
      contractVersion: 0,
      status: "DRAFT",
      rounds: [],
      artifacts: {},
      maxRounds: 12,
      verified: false,
    };
    return commit(root, s, "session.created", {
      "requirements.md": `${requirements}\n`,
    });
  });
}
export function prepare(
  cwd: string,
  id: string,
  value: unknown,
  mode: Mode,
  focus: string,
  expectedVersion: number,
): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    ensure(
      s.contractVersion === expectedVersion,
      "Contract version changed; reload before preparing",
    );
    ensure(
      ["planning", "review"].includes(mode),
      "Use assessment to generate an implementation handoff",
    );
    const c = validateContract(value, requirementsText(s));
    c.tasks
      .flatMap((t) => t.allowedPaths)
      .forEach((path) => safePath(root, path));
    if (s.contractVersion) stableIds(contract(root, s).contract, c);
    s.contractVersion++;
    const files = contractFiles(s, c);
    const v = JSON.parse(
      files[`${versionDirectory(s.contractVersion)}/contract.json`],
    ) as ContractVersion;
    const next = nextRound(s, v, mode, text(focus, "Assignment focus"));
    return commit(root, s, "handoff.prepared", { ...files, ...next.files });
  });
}
export function issue(
  cwd: string,
  id: string,
  mode: Mode,
  focus: string,
  taskId?: string,
): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    ensure(
      mode !== "implementation",
      "Implementation handoffs require a ready assessment",
    );
    const next = nextRound(
      s,
      contract(root, s),
      mode,
      text(focus, "Assignment focus"),
      taskId,
    );
    return commit(root, s, "handoff.issued", next.files);
  });
}
export function ingest(cwd: string, id: string): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
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
    const reply = validateReply(JSON.parse(raw));
    ensure(
      reply.sessionId === id &&
        reply.requestId === r.id &&
        reply.contractVersion === r.contractVersion &&
        reply.mode === r.mode &&
        reply.sourceFingerprint === r.source.fingerprint &&
        reply.requirementsDigest === r.requirementsDigest,
      "Reply identity or pinned inputs do not match this request",
    );
    const v = contract(root, s, r.contractVersion);
    const ids = v.contract.requirements.map((req) => req.id);
    ensure(
      reply.coverage.length === ids.length &&
        reply.coverage.every((row) => ids.includes(row.requirementId)),
      "Reply must cover every requirement exactly once",
    );
    if (reply.proposedContract) {
      validateContract(reply.proposedContract, requirementsText(s));
      stableIds(v.contract, reply.proposedContract);
    }
    r.reply = reply;
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
    return commit(root, s, stale ? "reply.stale" : "reply.received", {
      [`${dir}/received.json`]: raw,
      [`${dir}/observed-source.json`]: json(source),
    });
  });
}
export interface Assessment {
  requestId: string;
  decision: "ready" | "followup" | "needs_changes" | "blocked";
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
    identifier(a.requestId);
    const r = s.rounds.find((round) => round.id === a.requestId);
    ensure(
      r?.status === "RECEIVED" && r.reply,
      "Only a received, current reply can be assessed",
    );
    text(a.rationale, "Assessment rationale");
    ensure(
      ["ready", "followup", "needs_changes", "blocked"].includes(a.decision),
      "Unknown assessment decision",
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
    let c = contract(root, s).contract;
    if (a.contract) {
      c = validateContract(a.contract, requirementsText(s));
      stableIds(contract(root, s).contract, c);
      c.tasks
        .flatMap((t) => t.allowedPaths)
        .forEach((path) => safePath(root, path));
      s.contractVersion++;
      Object.assign(files, contractFiles(s, c, currentSource));
    }
    if (a.decision === "ready") {
      readyContract(c);
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
        r.reply.outcome === "ready",
        "Reply did not report readiness; resolve it in a follow-up round",
      );
      ensure(
        r.reply.findings
          .filter((f) => ["critical", "high"].includes(f.severity))
          .every((f) => seen.has(f.id)),
        "High/critical findings need explicit evidence-backed dispositions",
      );
    }
    r.status = "ASSESSED";
    r.decision = a.decision;
    r.rationale = a.rationale;
    r.dispositions = a.dispositions;
    files[`${roundDirectory(r)}/assessment.json`] = json({
      ...a,
      at: now(),
      verified: false,
    });
    files[`${roundDirectory(r)}/ASSESSMENT.md`] =
      `# ${a.decision}\n\n${a.rationale}\n\nRequest: ${r.id}. Delivery verified: false.\n\n## Finding dispositions\n\n${a.dispositions.map((d) => `- ${d.findingId}: ${d.disposition}. Evidence: ${d.evidence}`).join("\n") || "None."}\n`;
    if (a.decision === "ready" && r.mode === "planning") {
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
    } else if (a.decision === "ready") {
      s.status =
        r.mode === "implementation" ? "NEEDS_REVIEW" : "READY_FOR_HANDOFF";
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
        ).files,
      );
    } else s.status = a.decision === "blocked" ? "BLOCKED" : "NEEDS_CHANGES";
    return commit(root, s, "reply.assessed", files);
  });
}
export function cancel(cwd: string, id: string, reason: string): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    text(reason, "Cancellation reason");
    const r = s.rounds.findLast((round) =>
      ["WAITING", "RECEIVED"].includes(round.status),
    );
    ensure(r, "There is no pending request");
    r.status = "CANCELLED";
    r.rationale = reason;
    s.status = "NEEDS_CHANGES";
    return commit(root, s, "request.cancelled");
  });
}
export function amend(cwd: string, id: string, amendment: string): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
    text(amendment, "Requirement amendment");
    s.requirements.push(amendment);
    for (const r of s.rounds)
      if (["WAITING", "RECEIVED"].includes(r.status)) r.status = "STALE";
    s.status = "NEEDS_CHANGES";
    return commit(root, s, "requirements.amended", {
      [`amendments/${s.requirements.length - 1}.md`]: `${amendment}\n`,
    });
  });
}
export function status(cwd: string, id?: string): unknown {
  const root = projectRoot(cwd);
  if (!id) return { projectRoot: root, sessions: listSessions(root) };
  const s = loadSession(root, id);
  const r = s.rounds.findLast(
    (round) => round.status === "WAITING" || round.status === "RECEIVED",
  );
  const last = s.rounds.findLast((round) => round.status === "ASSESSED");
  const lastReply = s.rounds.findLast((round) => round.reply);
  return {
    sessionId: s.id,
    projectRoot: root,
    status: s.status,
    contractVersion: s.contractVersion,
    rounds: s.rounds.length,
    maxRounds: s.maxRounds,
    verified: false,
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
          status: r.status,
          handoffPath: join(
            root,
            sessionRelative(id),
            roundDirectory(r),
            "HANDOFF.md",
          ),
          replyPath: join(
            root,
            sessionRelative(id),
            roundDirectory(r),
            "reply.json",
          ),
          reply: r.reply ?? null,
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
        }
      : null,
    lastReply: lastReply
      ? {
          requestId: lastReply.id,
          mode: lastReply.mode,
          status: lastReply.status,
          summary: lastReply.reply!.summary,
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
      s.status === "DRAFT"
        ? "Inspect the project and prepare a contract and handoff."
        : r?.status === "WAITING"
          ? "Submit HANDOFF.md to the chosen agent, then run /waicc-continue when reply.json is ready."
          : r?.status === "RECEIVED"
            ? "Assess the received reply against the requirements and actual evidence."
            : s.status === "NEEDS_REVIEW"
              ? "Request independent review against the implementation and actual check evidence."
              : s.status === "READY_FOR_HANDOFF"
                ? "The reviewed artifact is ready for its next human-chosen handoff; delivery remains unverified."
                : "Resolve the reported blocker or issue a fresh request.",
  };
}
export function exportHandoff(cwd: string, id: string): string {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
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
      [`${dir}/reply.example.json`]: json(replyTemplate(s, r, v)),
      [`${dir}/conversation.json`]: json(conversation(s, r)),
      [`${dir}/manifest.json`]: json({
        schemaVersion: 1,
        sessionId: id,
        requestId: r.id,
        contractVersion: v.version,
        source: r.source,
        includesSourceCode: false,
        returnReplyTo: join(
          root,
          sessionRelative(id),
          roundDirectory(r),
          "reply.json",
        ),
      }),
      ...skillFiles(v.contract.skills, dir),
    };
    commit(root, s, "handoff.exported", files);
    return join(root, sessionRelative(id), dir);
  });
}
export function setRoundLimit(cwd: string, id: string, limit: number): Session {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const s = loadSession(root, id);
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
