import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  artifact,
  atomicWrite,
  digest,
  json,
  loadSession,
  now,
  readJson,
  readText,
  runtimePath,
  safePath,
  withLock,
} from "./files.ts";
import { overlap, words } from "./history.ts";
import { judge, memoryRule, quoteHolds, ruleContext, type RuleVerdict } from "./memory-rule.ts";
import { memoryAutoApprove, userConfigPath } from "./user-file.ts";
import { versionDirectory } from "./render.ts";
import { projectRoot } from "./source.ts";
import { ensure, identifier, relativePath, text } from "./validation.ts";
import type { ContractVersion, FindingRef, MemoryEntry } from "./types.ts";

function load(root: string): MemoryEntry[] {
  const path = safePath(root, `${runtimePath}/memory/entries.json`);
  if (!existsSync(path)) return [];
  const store = readJson<{ schemaVersion: number; entries: MemoryEntry[] }>(
    path,
  );
  ensure(
    store.schemaVersion === 1 && Array.isArray(store.entries),
    "Invalid memory store",
  );
  return store.entries;
}
function save(root: string, entries: MemoryEntry[]): void {
  atomicWrite(
    safePath(root, `${runtimePath}/memory/entries.json`),
    json({ schemaVersion: 1, entries }),
  );
}
// Common words would otherwise match nearly every entry when the query is a full request.
const stopWords = new Set(
  "the and for with that this from are was were has have had not but all any can will should must into onto than then them they their there what when where which who why how use using add also only each such other its our your you out new".split(
    " ",
  ),
);
/** A pattern lesson's evidence as it reads now: a changed or deleted finding makes the lesson stale. */
function evidenceDigest(root: string, evidence: FindingRef[]): string {
  return digest(json(evidence.map((ref) => {
    const finding = loadSession(root, ref.sessionId).rounds.find((round) => round.id === ref.requestId)?.reply?.findings.find((f) => f.id === ref.findingId);
    ensure(finding, `Finding ${ref.findingId} no longer exists`);
    return [ref.sessionId, ref.requestId, ref.findingId, finding.description, finding.evidence];
  })));
}
const sourceText = (root: string, path: string): string | null => {
  try {
    return readText(safePath(root, relativePath(path)));
  } catch {
    return null;
  }
};
/**
 * Whether what an entry rests on still reads as it did: its findings, its decision record, its
 * quoted lines (the rest of the file may change), or else the whole source file.
 */
function isCurrent(root: string, entry: MemoryEntry): boolean {
  if (entry.evidence) return evidenceDigest(root, entry.evidence) === entry.sourceDigest;
  if (entry.decision) return digest(artifact(root, loadSession(root, entry.decision.sessionId), entry.decision.record)) === entry.sourceDigest;
  const content = readText(safePath(root, relativePath(entry.source)));
  return entry.quote ? quoteHolds(content, entry.quote) : digest(content) === entry.sourceDigest;
}
type EntryState = MemoryEntry & { state: string; approvedBy?: "waicc-rule" };
/**
 * Every entry with its state: candidate, active, stale (what it rests on changed) or revoked.
 * With memory.autoApprove in your user file, a current candidate the rule confirms is active too.
 */
export function memoryStates(cwd: string): EntryState[] {
  const root = projectRoot(cwd);
  const entries = load(root);
  const auto = memoryAutoApprove();
  const context = ruleContext(root, entries, (path) => sourceText(root, path));
  return entries.map((entry) => {
    let state = entry.revoked ? "revoked" : entry.confirmedAt ? "active" : "candidate";
    try {
      if (!isCurrent(root, entry)) state = "stale";
    } catch {
      state = "stale";
    }
    if (state === "candidate" && auto && judge(entry, context).approved) return { ...entry, state: "active", approvedBy: "waicc-rule" as const };
    return { ...entry, state };
  });
}

export function recall(
  cwd: string,
  query = "",
  includeCandidates = false,
): (EntryState & { rule?: RuleVerdict })[] {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length > 2 && !stopWords.has(word)),
    ),
  ];
  const found = memoryStates(cwd)
    .filter(
      (entry) =>
        !entry.revoked && (includeCandidates || entry.state === "active"),
    )
    .map((entry) => ({
      entry,
      pattern: entry.evidence?.length ? 1 : 0,
      score: terms.filter((term) =>
        `${entry.text} ${entry.source}`.toLowerCase().includes(term),
      ).length,
    }))
    .filter(({ score, pattern }) => terms.length === 0 || score > 0 || pattern)
    .sort(
      (a, b) =>
        b.pattern - a.pattern || b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt),
    )
    .slice(0, 10)
    .map(({ entry }) => entry);
  if (!includeCandidates) return found;
  // For the human's list: what the rule makes of each candidate.
  const root = projectRoot(cwd);
  const context = ruleContext(root, load(root), (path) => sourceText(root, path));
  return found.map((entry) => (entry.state === "candidate" ? { ...entry, rule: judge(entry, context) } : entry));
}
/** Where a proposal was made: the WAICC session bound to the chat and the main agent's model. */
export interface Proposer {
  sessionId: string | null;
  model: string | null;
}
export function propose(
  cwd: string,
  claim: string,
  source: string,
  kind: MemoryEntry["kind"] = "lesson",
  quote?: string,
  by: Proposer = { sessionId: null, model: null },
): MemoryEntry {
  const root = projectRoot(cwd);
  text(claim, "Memory claim", 2000);
  source = relativePath(source);
  ensure(["fact", "decision", "lesson"].includes(kind), "Invalid memory kind");
  return withLock(root, () => {
    const entries = load(root);
    const content = readText(safePath(root, source));
    if (quote !== undefined) {
      text(quote, "Quote", 1200);
      ensure(quote.trim().length >= 12, "Quote at least a full line of the source");
      ensure(quoteHolds(content, quote), `The quote is not in ${source} exactly as written; copy the lines from the file`);
    }
    const sourceDigest = digest(content);
    const existing = entries.find(
      (entry) =>
        !entry.revoked &&
        entry.text === claim &&
        entry.source === source &&
        entry.sourceDigest === sourceDigest &&
        entry.kind === kind,
    );
    if (existing) return corroborate(root, entries, existing, by, quote);
    // The same claim about the same file from another session supports the earlier entry.
    const similar = by.sessionId ? entries.find((entry) => {
      if (entry.revoked || entry.kind !== kind || entry.source !== source || entry.evidence || entry.decision) return false;
      if (overlap(words(entry.text), words(claim)) < 0.6) return false;
      try {
        return isCurrent(root, entry);
      } catch {
        return false;
      }
    }) : undefined;
    if (similar) return corroborate(root, entries, similar, by, quote);
    ensure(
      entries.length < 500,
      "Memory has reached 500 entries; curate it before adding more",
    );
    const entry: MemoryEntry = {
      id: randomUUID(),
      kind,
      text: claim,
      source,
      sourceDigest,
      createdAt: now(),
      confirmedAt: null,
      revoked: false,
      ...(quote !== undefined ? { quote } : {}),
      ...(by.sessionId || by.model ? { proposedIn: by } : {}),
    };
    entries.push(entry);
    save(root, entries);
    return entry;
  });
}
/** Records a proposal from another session as support for an entry; the same session counts once. */
function corroborate(root: string, entries: MemoryEntry[], entry: MemoryEntry, by: Proposer, quote?: string): MemoryEntry {
  let changed = false;
  const seen = [entry.proposedIn?.sessionId, ...(entry.corroborations ?? []).map((c) => c.sessionId)];
  if (by.sessionId && !seen.includes(by.sessionId)) {
    entry.corroborations = [...(entry.corroborations ?? []), { sessionId: by.sessionId, model: by.model, at: now() }];
    changed = true;
  }
  if (quote !== undefined && !entry.quote) {
    entry.quote = quote;
    changed = true;
  }
  if (changed) save(root, entries);
  return entry;
}
/**
 * Saves a decision the human answered with /waicc-decide as memory, in WAICC's words: its
 * question and the human's exact answer. Policy and low-risk answers are not the human's own.
 */
export function proposeDecision(cwd: string, sessionId: string, decisionId: string, by: Proposer): MemoryEntry {
  const root = projectRoot(cwd);
  identifier(decisionId, "Decision ID");
  const s = loadSession(root, sessionId);
  const contract = (JSON.parse(artifact(root, s, `${versionDirectory(s.contractVersion)}/contract.json`)) as ContractVersion).contract;
  const decision = contract.decisions?.find((d) => d.id.toLowerCase() === decisionId.toLowerCase());
  ensure(decision, `No decision ${decisionId} in session ${sessionId}`);
  ensure(decision.status === "resolved" && decision.answer, `Decision ${decision.id} is not answered yet`);
  const records = Object.keys(s.artifacts).filter((path) => /^decisions\/[0-9a-f-]{36}\.json$/.test(path))
    .map((path) => ({ path, content: artifact(root, s, path) }))
    .map((r) => ({ ...r, record: JSON.parse(r.content) as { decisionId: string; answer: string; recordedBy: string; recordedAt: string } }))
    .filter((r) => r.record.decisionId === decision.id && r.record.answer === decision.answer)
    .sort((a, b) => b.record.recordedAt.localeCompare(a.record.recordedAt));
  const record = records[0];
  ensure(record, `Decision ${decision.id} has no answer record`);
  ensure(record.record.recordedBy === "human-command",
    `Decision ${decision.id} was answered by ${record.record.recordedBy === "standing-policy" ? "a standing policy" : "your low-risk setting"}, not by the human directly; propose it as a fact with a quote instead`);
  return withLock(root, () => {
    const entries = load(root);
    const existing = entries.find((entry) => !entry.revoked && entry.decision?.sessionId === s.id && entry.decision.decisionId === decision.id);
    if (existing) return existing;
    ensure(entries.length < 500, "Memory has reached 500 entries; curate it before adding more");
    const entry: MemoryEntry = {
      id: randomUUID(), kind: "decision",
      text: text(`${decision.question} Answer: ${decision.answer}`, "Decision", 2000),
      source: `decision ${decision.id} in session ${s.id.slice(0, 8)}`,
      sourceDigest: digest(record.content),
      createdAt: now(), confirmedAt: null, revoked: false,
      decision: { sessionId: s.id, decisionId: decision.id, record: record.path },
      ...(by.sessionId || by.model ? { proposedIn: by } : {}),
    };
    entries.push(entry);
    save(root, entries);
    return entry;
  });
}
/** Human-command-only promotion. Existence of a source is not semantic verification. */
export function curate(
  cwd: string,
  id: string,
  action: "confirm" | "revoke",
): MemoryEntry {
  const root = projectRoot(cwd);
  identifier(id);
  return withLock(root, () => {
    const entries = load(root);
    const entry = entries.find((row) => row.id === id);
    ensure(entry, "Unknown memory ID");
    if (action === "confirm") {
      ensure(
        !entry.revoked,
        "Cannot confirm a revoked entry; propose a corrected replacement",
      );
      ensure(
        isCurrent(root, entry),
        "Memory source changed; inspect it and propose a new candidate",
      );
      entry.confirmedAt = now();
      entry.confirmedBy = "human";
    } else entry.revoked = true;
    save(root, entries);
    return entry;
  });
}

/**
 * A lesson from review findings that recur across sessions, as a candidate for the human to
 * confirm. A finding backs at most one lesson, so the same pattern is never proposed twice.
 */
export function proposeLesson(cwd: string, claim: string, evidence: FindingRef[]): MemoryEntry {
  const root = projectRoot(cwd);
  text(claim, "Lesson", 600);
  return withLock(root, () => {
    const entries = load(root);
    const earlier = lessonUsing(entries, evidence);
    ensure(!earlier, earlier?.revoked
      ? `The human already rejected a lesson from these findings (${earlier.id}: "${earlier.text}"); do not propose it again.`
      : `These findings already back lesson ${earlier?.id} ("${earlier?.text}"); it is ${earlier?.confirmedAt ? "confirmed" : "waiting for the human to confirm"}.`);
    ensure(entries.length < 500, "Memory has reached 500 entries; curate it before adding more");
    const entry: MemoryEntry = {
      id: randomUUID(), kind: "lesson", text: claim,
      source: lessonSource(evidence),
      sourceDigest: evidenceDigest(root, evidence),
      createdAt: now(), confirmedAt: null, revoked: false, evidence,
    };
    entries.push(entry);
    save(root, entries);
    return entry;
  });
}
const sameFinding = (a: FindingRef, b: FindingRef) => a.sessionId === b.sessionId && a.requestId === b.requestId && a.findingId === b.findingId;
const lessonUsing = (entries: MemoryEntry[], evidence: FindingRef[]) =>
  entries.find((entry) => entry.evidence?.some((ref) => evidence.some((other) => sameFinding(ref, other))));
const lessonSource = (evidence: FindingRef[]) => `review findings: ${evidence.length} in ${new Set(evidence.map((ref) => ref.sessionId)).size} sessions`;
/** The same pattern found again in another session: its findings join the lesson as more support. */
export function strengthenLesson(cwd: string, lessonId: string, evidence: FindingRef[]): MemoryEntry {
  const root = projectRoot(cwd);
  identifier(lessonId, "Lesson ID");
  return withLock(root, () => {
    const entries = load(root);
    const lesson = entries.find((entry) => entry.id === lessonId);
    ensure(lesson?.evidence?.length, `No lesson from recurring findings has ID ${lessonId}`);
    ensure(!lesson.revoked, `The human revoked lesson ${lessonId}; do not add to it`);
    const used = lessonUsing(entries, evidence);
    ensure(!used, `A cited finding already backs lesson ${used?.id} ("${used?.text}")`);
    const known = new Set(lesson.evidence.map((ref) => ref.sessionId));
    ensure(evidence.some((ref) => !known.has(ref.sessionId)), "Add findings from a session the lesson does not rest on yet");
    // Still current before, so the new digest does not hide an earlier change.
    ensure(isCurrent(root, lesson), "A finding this lesson rests on changed; propose a fresh lesson instead");
    lesson.evidence = [...lesson.evidence, ...evidence];
    lesson.source = lessonSource(lesson.evidence);
    lesson.sourceDigest = evidenceDigest(root, lesson.evidence);
    save(root, entries);
    return lesson;
  });
}

/** Lessons from recurring findings still waiting for the human; read without re-checking sources. */
export function pendingLessons(cwd: string): MemoryEntry[] {
  try {
    const root = projectRoot(cwd);
    const entries = load(root);
    const pending = entries.filter((entry) => entry.evidence?.length && !entry.confirmedAt && !entry.revoked);
    if (!memoryAutoApprove()) return pending;
    // The rule's lesson check reads only the entries, so it stays cheap enough for the tracker.
    const context = ruleContext(root, entries, () => null);
    return pending.filter((entry) => !judge(entry, context).approved);
  } catch {
    return [];
  }
}

/**
 * Replays the rule over every entry, beside what you did with it: how often it agrees with your
 * confirmations, and whether it would have confirmed anything you revoked.
 */
export function auditMemory(cwd: string) {
  const root = projectRoot(cwd);
  const entries = load(root);
  const context = ruleContext(root, entries, (path) => sourceText(root, path));
  const rows = entries.map((entry) => ({
    id: entry.id, kind: entry.kind, text: entry.text, source: entry.source,
    yours: entry.revoked ? "revoked" : entry.confirmedAt ? "confirmed" : "candidate",
    rule: judge(entry, context),
  }));
  const confirmed = rows.filter((row) => row.yours === "confirmed"), revoked = rows.filter((row) => row.yours === "revoked");
  const mistakes = revoked.filter((row) => row.rule.approved);
  const enabled = memoryAutoApprove();
  return {
    autoApprove: enabled ? "on" : "off",
    rule: { factPoints: memoryRule.factPoints, lessonSessions: memoryRule.lessonSessions },
    youConfirmed: confirmed.length,
    ruleWouldConfirmOfThose: confirmed.filter((row) => row.rule.approved).length,
    youRevoked: revoked.length,
    ruleWouldHaveConfirmed: mistakes.map(({ id, text, rule }) => ({ id, text, reasons: rule.reasons })),
    candidatesRuleConfirmsNow: rows.filter((row) => row.yours === "candidate" && row.rule.approved).map(({ id, text, rule }) => ({ id, text, reasons: rule.reasons })),
    entries: rows,
    nextAction: mistakes.length
      ? `The rule would have confirmed ${mistakes.length} entr${mistakes.length === 1 ? "y" : "ies"} you revoked: keep confirming by hand, or revoke similar candidates so the rule learns from them.`
      : enabled
        ? "The rule is on: candidates it confirms are recalled like your own. Revoke any with /waicc-memory revoke."
        : `The rule confirmed nothing you revoked. To let it confirm candidates, add "memory": { "autoApprove": true } to ${userConfigPath()}.`,
  };
}
