import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
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
import { projectRoot } from "./source.ts";
import { ensure, identifier, relativePath, text } from "./validation.ts";
import type { FindingRef, MemoryEntry } from "./types.ts";

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
const currentDigest = (root: string, entry: MemoryEntry): string =>
  entry.evidence ? evidenceDigest(root, entry.evidence) : digest(readText(safePath(root, relativePath(entry.source))));
/** Every entry with its state: candidate, active, stale (its source changed) or revoked. */
export function memoryStates(cwd: string): (MemoryEntry & { state: string })[] {
  const root = projectRoot(cwd);
  return load(root).map((entry) => {
    let state = entry.revoked ? "revoked" : entry.confirmedAt ? "active" : "candidate";
    try {
      if (currentDigest(root, entry) !== entry.sourceDigest) state = "stale";
    } catch {
      state = "stale";
    }
    return { ...entry, state };
  });
}

export function recall(
  cwd: string,
  query = "",
  includeCandidates = false,
): (MemoryEntry & { state: string })[] {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length > 2 && !stopWords.has(word)),
    ),
  ];
  return memoryStates(cwd)
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
}
export function propose(
  cwd: string,
  claim: string,
  source: string,
  kind: MemoryEntry["kind"] = "lesson",
): MemoryEntry {
  const root = projectRoot(cwd);
  text(claim, "Memory claim", 2000);
  source = relativePath(source);
  ensure(["fact", "decision", "lesson"].includes(kind), "Invalid memory kind");
  return withLock(root, () => {
    const entries = load(root);
    const sourceDigest = digest(readText(safePath(root, source)));
    const existing = entries.find(
      (entry) =>
        !entry.revoked &&
        entry.text === claim &&
        entry.source === source &&
        entry.sourceDigest === sourceDigest &&
        entry.kind === kind,
    );
    if (existing) return existing;
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
        currentDigest(root, entry) === entry.sourceDigest,
        "Memory source changed; inspect it and propose a new candidate",
      );
      entry.confirmedAt = now();
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
    const same = (a: FindingRef, b: FindingRef) => a.sessionId === b.sessionId && a.requestId === b.requestId && a.findingId === b.findingId;
    const earlier = entries.find((entry) => entry.evidence?.some((ref) => evidence.some((other) => same(ref, other))));
    ensure(!earlier, earlier?.revoked
      ? `The human already rejected a lesson from these findings (${earlier.id}: "${earlier.text}"); do not propose it again.`
      : `These findings already back lesson ${earlier?.id} ("${earlier?.text}"); it is ${earlier?.confirmedAt ? "confirmed" : "waiting for the human to confirm"}.`);
    ensure(entries.length < 500, "Memory has reached 500 entries; curate it before adding more");
    const sessions = new Set(evidence.map((ref) => ref.sessionId)).size;
    const entry: MemoryEntry = {
      id: randomUUID(), kind: "lesson", text: claim,
      source: `review findings: ${evidence.length} in ${sessions} sessions`,
      sourceDigest: evidenceDigest(root, evidence),
      createdAt: now(), confirmedAt: null, revoked: false, evidence,
    };
    entries.push(entry);
    save(root, entries);
    return entry;
  });
}

/** Lessons from recurring findings still waiting for the human; read without re-checking sources. */
export function pendingLessons(cwd: string): MemoryEntry[] {
  try {
    return load(projectRoot(cwd)).filter((entry) => entry.evidence?.length && !entry.confirmedAt && !entry.revoked);
  } catch {
    return [];
  }
}
