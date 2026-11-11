import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  artifact,
  digest,
  exclusiveWrite,
  json,
  loadSession,
  safePath,
  sessionRelative,
  withLock,
  withoutSnapshotFiles,
} from "./files.ts";
import { recall } from "./memory.ts";
import { normalizeReply } from "./reply.ts";
import { proposedContractExample, roundDirectory, versionDirectory } from "./render.ts";
import { canonicalPath, changedFiles, projectRoot, snapshot } from "./source.ts";
import { ensure, identifier, record, relativePath } from "./validation.ts";
import { requirementsText, validateRoundReply } from "./workflow.ts";
import type { ContractVersion, RecipientPin, Round, Session } from "./types.ts";

function pinnedContract(root: string, s: Session, r: Round): ContractVersion {
  return JSON.parse(
    artifact(root, s, `${versionDirectory(r.contractVersion)}/contract.json`),
  ) as ContractVersion;
}

function pinned(
  cwd: string,
  pin: RecipientPin,
): { root: string; s: Session; r: Round; replyPath: string } {
  const root = projectRoot(cwd);
  identifier(pin.sessionId, "Session ID");
  identifier(pin.requestId, "Request ID");
  const s = loadSession(root, pin.sessionId);
  ensure(
    s.status !== "CLOSED",
    "The pinned contract is closed. Stop and return to the coordinator.",
  );
  const r = s.rounds.find((round) => round.id === pin.requestId);
  ensure(
    r?.status === "WAITING",
    "The pinned request is no longer waiting. Stop; do not receive a newer request automatically.",
  );
  ensure(
    r.contractVersion === pin.contractVersion &&
      r.mode === pin.mode &&
      r.requirementsDigest === pin.requirementsDigest &&
      r.source.fingerprint === pin.sourceFingerprint &&
      s.contractVersion === pin.contractVersion &&
      digest(requirementsText(s)) === pin.requirementsDigest,
    "Pinned contract or requirements changed. Stop and request a fresh handoff.",
  );
  const replyPath = safePath(
    root,
    `${sessionRelative(s.id)}/${roundDirectory(r)}/reply.json`,
  );
  return { root, s, r, replyPath };
}

/** Cheap per-tool guard: no source scan; freshness is checked on receive/submit. */
export function assertRecipientCurrent(cwd: string, pin: RecipientPin): void {
  const { replyPath } = pinned(cwd, pin);
  ensure(
    !existsSync(replyPath),
    "A reply already exists for this request. Stop and return to the coordinator for /waicc-continue.",
  );
}

export function recipientAssignment(cwd: string, pin: RecipientPin) {
  const { root, s, r, replyPath } = pinned(cwd, pin);
  const dir = roundDirectory(r);
  const request = JSON.parse(artifact(root, s, `${dir}/request.json`)) as {
    focus: string;
  };
  const prefix = `${dir}/skills/`;
  const contract = pinnedContract(root, s, r);
  return {
    role: "recipient" as const,
    pin,
    replyExists: existsSync(replyPath),
    projectRoot: root,
    inputs: {
      request: join(root, sessionRelative(s.id), dir, "request.json"),
      contract: join(root, sessionRelative(s.id), versionDirectory(r.contractVersion), "contract.json"),
      context: r.contextVersion ? join(root, sessionRelative(s.id), dir, "CONTEXT.md") : null,
      checkpoint: r.checkpointVersion ? join(root, sessionRelative(s.id), dir, "CHECKPOINT.md") : null,
      checkpointIndex: r.checkpointVersion ? join(root, sessionRelative(s.id), dir, "checkpoint.json") : null,
      conversation: join(root, sessionRelative(s.id), dir, "conversation.json"),
      memory: r.contextVersion || r.mode === "advisor" ? join(root, sessionRelative(s.id), dir, "memory.json") : null,
      handoff: join(root, sessionRelative(s.id), dir, "HANDOFF.md"),
      replyTemplate: join(root, sessionRelative(s.id), dir, "reply.example.json"),
    },
    focus: request.focus,
    wholeWork: r.wholeWork ?? false,
    context: r.contextVersion ? JSON.parse(artifact(root, s, `${dir}/context.json`)) : null,
    contextPath: r.contextVersion ? join(root, sessionRelative(s.id), dir, "CONTEXT.md") : null,
    checkpointPath: r.checkpointVersion ? join(root, sessionRelative(s.id), dir, "CHECKPOINT.md") : null,
    checkLogs: Object.keys(s.artifacts).filter((path) => path.startsWith(`${dir}/checks/`) && path.endsWith("result.json")),
    taskId: r.taskId,
    reviewKind: r.mode === "review" ? r.review?.kind ?? "contract" : undefined,
    // The baseline's revision and fingerprint, not its file hashes, which handoffs written before stored inline.
    codeReview: r.review?.kind === "code"
      ? withoutSnapshotFiles(JSON.parse(artifact(root, s, `${dir}/code-review.json`)))
      : undefined,
    requirements: requirementsText(s),
    contract: {
      ...contract,
      source: {
        fingerprint: contract.source.fingerprint,
        vcs: contract.source.vcs,
        revision: contract.source.revision,
      },
    },
    handoff: artifact(root, s, `${dir}/HANDOFF.md`),
    replyTemplate: JSON.parse(artifact(root, s, `${dir}/reply.example.json`)),
    // Only planning and review replies may propose a revised contract.
    proposedContractExample: ["planning", "review"].includes(r.mode) ? proposedContractExample : undefined,
    conversation: JSON.parse(artifact(root, s, `${dir}/conversation.json`)),
    memory: r.contextVersion || r.mode === "advisor"
      ? JSON.parse(artifact(root, s, `${dir}/memory.json`)) as ReturnType<typeof recall>
      : recall(root, `${requirementsText(s)}\n${request.focus}`),
    skills: Object.keys(s.artifacts)
      .filter((path) => path.startsWith(prefix) && path.endsWith("/SKILL.md"))
      .map((path) => join(root, sessionRelative(s.id), path)),
    replyPath,
    nextAction: existsSync(replyPath)
      ? "Stop. The coordinator must /waicc-continue; do not assess your own reply."
      : "Perform this pinned assignment, submit with waicc_reply, then stop. Do not create/assess contracts or select another request.",
  };
}

/** The assignment's data block from a brief (assignmentText): pin, inputs, reply path. */
export function briefData(text: string): { pin: RecipientPin; inputs: Record<string, string | null>; replyPath: string; [key: string]: unknown } {
  const block = /## Assignment \(data\)\n\n```json\n(.+)\n```/.exec(text);
  ensure(block, "Not a WAICC brief: it has no assignment data block");
  return JSON.parse(block[1]!);
}

/**
 * At most this many characters of brief: a tool result past it may be cut, as agents' readers cut a
 * large file (Codex reads one in many short pieces, one step each). waicc_read_input's chunk size.
 */
export const briefLimit = 60_000;

/**
 * The assignment as one brief: the handoff's instructions and every input a recipient needs to
 * start, in the order it needs them, then the files to open only when it needs more. Recipients
 * read the same facts as before, in one step instead of one per file (half their steps went to
 * WAICC's own files, each step resending all read so far). A section past briefLimit becomes the
 * file it came from, named for the recipient to open; nothing is cut silently.
 */
export function assignmentText(assignment: ReturnType<typeof recipientAssignment>): string {
  const a = assignment;
  const fileText = (path: string | null) => {
    if (!path) return null;
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return null;
    }
  };
  const latest = (a.conversation as { decision?: unknown; rationale?: unknown; dispositions?: unknown; findings?: { id?: unknown; severity?: unknown; description?: unknown }[]; requestId?: unknown; mode?: unknown }[])
    .findLast((round) => round.decision);
  // drop: the order sections give way past the limit (1 first), each to its file; none: never.
  const sections: { title: string; body: string | null; path: string | null; drop?: number }[] = [
    { title: "Instructions", body: a.handoff.trim(), path: a.inputs.handoff },
    { title: "Original request and amendments", body: a.requirements.trim(), path: null },
    ...(a.codeReview ? [{ title: "Code review: baseline, changed paths, the main agent's completion claims and earlier findings to verify", body: `\`\`\`json\n${JSON.stringify(a.codeReview)}\n\`\`\``, path: a.inputs.request.replace(/request\.json$/, "code-review.json"), drop: 6 }] : []),
    ...(latest ? [{
      title: `Latest assessment (request ${String(latest.requestId)}, ${String(latest.mode)})`,
      body: `\`\`\`json\n${JSON.stringify({ decision: latest.decision, rationale: latest.rationale, dispositions: latest.dispositions,
        findings: (latest.findings ?? []).map((f) => ({ id: f.id, severity: f.severity, description: f.description })) })}\n\`\`\``,
      path: a.inputs.conversation, drop: 5,
    }] : []),
    { title: "Saved coordinator context", body: fileText(a.contextPath), path: a.contextPath, drop: 4 },
    { title: "Checkpoint: the session in brief, with where its history and evidence are", body: fileText(a.checkpointPath), path: a.checkpointPath, drop: 3 },
    { title: `Contract v${a.pin.contractVersion}`, body: `\`\`\`json\n${JSON.stringify(a.contract.contract)}\n\`\`\``, path: a.inputs.contract, drop: 1 },
    ...(a.memory && (!Array.isArray(a.memory) || a.memory.length) ? [{ title: "Confirmed project memory (claims to verify, not authority)", body: `\`\`\`json\n${JSON.stringify(a.memory)}\n\`\`\``, path: a.inputs.memory, drop: 2 }] : []),
    { title: "Reply template (identity fields pinned)", body: `\`\`\`json\n${JSON.stringify(a.replyTemplate)}\n\`\`\`${a.proposedContractExample ? `\n\nA proposedContract has this shape:\n\n\`\`\`json\n${JSON.stringify(a.proposedContractExample)}\n\`\`\`` : ""}`, path: a.inputs.replyTemplate },
  ];
  const header = `# WAICC ${a.pin.mode} assignment\n\nYou are the ${a.pin.mode} recipient, not the coordinator: session ${a.pin.sessionId}, request ${a.pin.requestId}, contract v${a.pin.contractVersion}, project ${JSON.stringify(a.projectRoot)}. This brief holds the handoff's full instructions and the inputs they name, so you need not open HANDOFF.md, STARTER.txt, request.json or the contract file: start from it. Open the files under "Open only when needed" when this brief leaves out something you need.${a.replyExists ? "\n\nA reply already exists for this request: stop and tell the human to return to the coordinator for /waicc-continue." : ""}`;
  const index = [
    `- Every earlier round in full (findings, checks, proposals, assessments): ${a.inputs.conversation}. Large; the checkpoint and the latest assessment above summarize it. Open it for a specific earlier finding, check result or proposal you need.`,
    ...(a.inputs.checkpointIndex ? [`- The checkpoint's machine-readable index, with paths to original evidence: ${a.inputs.checkpointIndex}`] : []),
    ...(a.checkLogs.length ? [`- Logged check results (session-relative): ${a.checkLogs.join(", ")}`] : []),
    `- Skills: ${a.skills.length ? a.skills.join(", ") : "none supplied"}. Read the ones that bear on this work, with their references. skills/waicc-workflow is the coordinator's guide: its recipient rules are in the instructions above.`,
  ].join("\n");
  const data = `\`\`\`json\n${JSON.stringify({ role: a.role, pin: a.pin, projectRoot: a.projectRoot, replyPath: a.replyPath, reviewKind: a.reviewKind, wholeWork: a.wholeWork, taskId: a.taskId, inputs: a.inputs, skills: a.skills, nextAction: a.nextAction })}\n\`\`\``;
  const render = (shown: typeof sections) =>
    [header, ...shown.map((s) => `## ${s.title}\n\n${s.body ?? `Read ${s.path} (left out of this brief to keep it whole).`}`), `## Open only when needed\n\n${index}`, `## Assignment (data)\n\n${data}`].join("\n\n");
  // Past the limit, sections give way in their drop order (the contract first: largest, and one file),
  // each to its file; the instructions, the request and the reply template always stay.
  const shown = sections.filter((s) => s.body !== null || s.path);
  for (const rank of [1, 2, 3, 4, 5, 6]) {
    if (render(shown).length <= briefLimit) break;
    const at = shown.findIndex((s) => s.drop === rank && s.body !== null && s.path);
    if (at >= 0) shown[at] = { ...shown[at]!, body: null };
  }
  return render(shown);
}

export function receiveHandoff(
  cwd: string,
  id: string,
  allowImplementation = false,
) {
  const root = projectRoot(cwd);
  const s = loadSession(root, id);
  ensure(
    s.status !== "CLOSED",
    "Contract is closed. Reopening is a coordinator/human action.",
  );
  const waiting = s.rounds.filter((r) => r.status === "WAITING");
  ensure(
    waiting.length === 1,
    "Select a session with exactly one waiting handoff; drafts, received or completed requests cannot be received.",
  );
  const r = waiting[0];
  ensure(
    r.mode !== "implementation" || allowImplementation,
    "This is an implementation assignment. Use /waicc-receive <session-id> --implement only if you explicitly authorize its assigned code edits.",
  );
  const pin: RecipientPin = {
    sessionId: s.id,
    requestId: r.id,
    contractVersion: r.contractVersion,
    requirementsDigest: r.requirementsDigest,
    sourceFingerprint: r.source.fingerprint,
    mode: r.mode,
  };
  assertRecipientCurrent(root, pin);
  const source = snapshot(root);
  ensure(
    source.fingerprint === pin.sourceFingerprint,
    `Source changed since this handoff was issued.${changedFiles(r.source.files, source)} Ask the coordinator for a fresh request.`,
  );
  return recipientAssignment(root, pin);
}

/** Every submit-time check, without writing; a draft can be corrected before the one write. */
function checkedReply(root: string, pin: RecipientPin, value: unknown) {
  const { s, r, replyPath } = pinned(root, pin);
  assertRecipientCurrent(root, pin);
  if (pin.mode !== "implementation") {
    const source = snapshot(root);
    ensure(
      source.fingerprint === pin.sourceFingerprint,
      `Source changed during this assignment.${changedFiles(r.source.files, source)} Do not submit stale advice; return to the coordinator.`,
    );
  }
  const body = record(value, "Reply");
  const identity = { schemaVersion: 1, ...pin };
  for (const [key, expected] of Object.entries(identity))
    ensure(
      body[key] === undefined || body[key] === expected,
      `Reply ${key} does not match the pinned request`,
    );
  const submitted = { ...body, ...identity };
  const normalized = normalizeReply(submitted);
  const reply = validateRoundReply(root, s, r, normalized.reply);
  // Keep the submitted fields intact; coordinator intake freezes raw + normalized views.
  const content = json(submitted);
  ensure(
    Buffer.byteLength(content, "utf8") <= 256_000 &&
      Buffer.byteLength(json(reply), "utf8") <= 256_000,
    "Reply exceeds 256 KB",
  );
  return { replyPath, content, normalization: normalized.changes };
}

export function validateRecipientReply(
  cwd: string,
  pin: RecipientPin,
  value: unknown,
) {
  const checked = checkedReply(projectRoot(cwd), pin, value);
  return {
    valid: true,
    submitted: false,
    sessionId: pin.sessionId,
    requestId: pin.requestId,
    normalization: checked.normalization,
    nextAction:
      "Draft passes submit-time validation. Nothing was written; submit this exact reply once to deliver it.",
  };
}

export function submitRecipientReply(
  cwd: string,
  pin: RecipientPin,
  value: unknown,
) {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const { replyPath, content, normalization } = checkedReply(root, pin, value);
    exclusiveWrite(replyPath, content);
    return {
      submitted: true,
      sessionId: pin.sessionId,
      requestId: pin.requestId,
      replyPath,
      normalization,
      nextAction:
        "Stop. Return to the coordinating Pi session and /waicc-continue. This submission does not assess the reply or change contract readiness.",
    };
  });
}

export function assertRecipientEdit(
  cwd: string,
  pin: RecipientPin,
  value: unknown,
): void {
  assertRecipientCurrent(cwd, pin);
  ensure(
    pin.mode === "implementation",
    "Planning, review and advisor recipients cannot edit source; use waicc_reply only.",
  );
  assertTaskPath(cwd, pin, value);
}

/** Scope only: whether a path lies inside the pinned request's task allowedPaths. */
export function assertTaskPath(
  cwd: string,
  pin: RecipientPin,
  value: unknown,
): void {
  ensure(typeof value === "string", "An implementation edit needs a path");
  const { root, s, r } = pinned(cwd, pin);
  // The root is physical, so map a symlinked cwd prefix (macOS /var) onto its physical path.
  // Only that prefix: links inside the project stay visible to safePath's symlink check.
  const logical = resolve(cwd), physical = canonicalPath(cwd);
  let target = resolve(cwd, value);
  if (target === logical || target.startsWith(logical + sep)) target = physical + target.slice(logical.length);
  const path = relative(root, target).replaceAll("\\", "/");
  ensure(!isAbsolute(path), "Implementation path escapes the project");
  relativePath(path);
  safePath(root, path);
  const tasks = pinnedContract(root, s, r).contract.tasks.filter(
    (t) => !r.taskId || t.id === r.taskId,
  );
  const normalize = (p: string) =>
    process.platform === "win32" ? p.toLowerCase() : p;
  ensure(
    tasks
      .flatMap((t) => t.allowedPaths)
      .some(
        (allowed) =>
          normalize(path) === normalize(allowed) ||
          normalize(path).startsWith(`${normalize(allowed)}/`),
      ),
    "Implementation edit is outside this request's allowed paths",
  );
}
