import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  atomicWrite,
  digest,
  json,
  now,
  readJson,
  readText,
  runtimePath,
  safePath,
  withLock,
} from "./files.ts";
import { projectRoot } from "./source.ts";
import { ensure, identifier, relativePath, text } from "./validation.ts";
import type { MemoryEntry } from "./types.ts";

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
export function recall(
  cwd: string,
  query = "",
  includeCandidates = false,
): (MemoryEntry & { state: string })[] {
  const root = projectRoot(cwd);
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length > 2 && !stopWords.has(word)),
    ),
  ];
  return load(root)
    .map((entry) => {
      let state = entry.revoked
        ? "revoked"
        : entry.confirmedAt
          ? "active"
          : "candidate";
      try {
        if (
          digest(readText(safePath(root, relativePath(entry.source)))) !==
          entry.sourceDigest
        )
          state = "stale";
      } catch {
        state = "stale";
      }
      return { ...entry, state };
    })
    .filter(
      (entry) =>
        !entry.revoked && (includeCandidates || entry.state === "active"),
    )
    .map((entry) => ({
      entry,
      score: terms.filter((term) =>
        `${entry.text} ${entry.source}`.toLowerCase().includes(term),
      ).length,
    }))
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt),
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
        digest(readText(safePath(root, relativePath(entry.source)))) ===
          entry.sourceDigest,
        "Memory source changed; inspect it and propose a new candidate",
      );
      entry.confirmedAt = now();
    } else entry.revoked = true;
    save(root, entries);
    return entry;
  });
}
