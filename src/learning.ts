import { existsSync, readdirSync } from "node:fs";
import { loadSession, runtimePath, safePath } from "./files.ts";
import { memoryStates, proposeLesson } from "./memory.ts";
import { projectRoot } from "./source.ts";
import { ensure, identifier, list, record, text } from "./validation.ts";
import type { FindingRef, MemoryEntry, Session } from "./types.ts";

/** A review finding the main agent assessed and did not dispute: evidence of a real problem. */
interface ReviewFinding extends FindingRef {
  sessionTitle: string;
  severity: string;
  description: string;
}

const stop = new Set("the and for with that this from are was were has have had not but all any can will should must into than then them they their there what when where which who why how use using add also only each such other its our your you out new does done when while been being more most very".split(" "));
/** Significant words, crudely stemmed, so "tests"/"testing"/"tested" meet. */
const words = (value: string): Set<string> => new Set(value.toLowerCase().replace(/`[^`]*`/g, " ").split(/[^a-z]+/)
  .filter((word) => word.length > 2 && !stop.has(word)).map((word) => word.replace(/(ing|ed|es|s)$/, "")).filter((word) => word.length > 2));
const overlap = (a: Set<string>, b: Set<string>): number => {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared ? shared / (a.size + b.size - shared) : 0;
};

function reviewFindings(s: Session): ReviewFinding[] {
  const title = s.requirements[0]?.split("\n")[0]?.slice(0, 120) ?? "Untitled";
  return s.rounds.filter((r) => r.mode === "review" && r.status === "ASSESSED" && r.reply).flatMap((r) => {
    const disputed = new Set((r.dispositions ?? []).filter((d) => d.disposition === "disputed").map((d) => d.findingId));
    return r.reply!.findings.filter((f) => !disputed.has(f.id) && f.severity !== "info")
      .map((f) => ({ sessionId: s.id, requestId: r.id, findingId: f.id, sessionTitle: title, severity: f.severity, description: f.description.slice(0, 400) }));
  });
}
function otherSessions(root: string, except: string): Session[] {
  const folder = safePath(root, `${runtimePath}/sessions`);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((id) => /^[a-f0-9-]{36}$/.test(id) && id !== except).flatMap((id) => {
    try {
      return [loadSession(root, id)];
    } catch {
      return [];
    }
  });
}

/**
 * After a review is assessed: earlier sessions' findings that resemble this review's, for the
 * main agent to judge. Word overlap only ranks them; whether two are the same kind of problem
 * is the agent's call, and the human confirms any lesson. Null when there is nothing to compare.
 */
export function recurringFindings(cwd: string, sessionId: string, requestId: string) {
  const root = projectRoot(cwd);
  const s = loadSession(root, sessionId);
  const current = reviewFindings(s).filter((f) => f.requestId === requestId);
  if (!current.length) return null;
  const used = new Set<string>();
  const lessons = memoryStates(root).filter((entry) => entry.evidence?.length);
  for (const lesson of lessons) for (const ref of lesson.evidence!) used.add(`${ref.sessionId}/${ref.requestId}/${ref.findingId}`);
  const mine = current.map((f) => ({ finding: f, words: words(f.description) }));
  const earlier = otherSessions(root, sessionId).flatMap(reviewFindings)
    .filter((f) => !used.has(`${f.sessionId}/${f.requestId}/${f.findingId}`))
    .map((f) => {
      const theirs = words(f.description);
      const best = mine.map((m) => ({ id: m.finding.findingId, score: overlap(m.words, theirs) })).sort((a, b) => b.score - a.score)[0];
      return { ...f, resembles: best.id, similarity: Math.round(best.score * 100) / 100 };
    })
    .filter((f) => f.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 15);
  if (!earlier.length) return null;
  return {
    thisReview: current.map(({ sessionId: _s, sessionTitle: _t, ...f }) => f),
    earlierFindings: earlier,
    existingLessons: lessons.filter((entry) => entry.state !== "revoked").map((entry) => ({ id: entry.id, text: entry.text, state: entry.state })),
    instruction: "LEARN ACROSS SESSIONS: earlier sessions in this project had review findings that may resemble this review's (most similar first; the score only counts shared words). If one of this review's findings is genuinely the same kind of problem as one or more earlier findings (same root cause or the same missing practice, not just similar words), call waicc_learn_pattern once for that pattern: a short lesson for future plans saying what to plan or check up front, and the findings it rests on (this review's finding and the earlier ones). Skip patterns an existing lesson already covers and one-off problems. A lesson is only a candidate until the human confirms it with /waicc-memory confirm; tell them you proposed it.",
  };
}

/** Validates the cited findings, then proposes the lesson for the human to confirm. */
export function learnPattern(cwd: string, lesson: unknown, findings: unknown): MemoryEntry {
  const root = projectRoot(cwd);
  const claim = text(lesson, "Lesson", 600).trim();
  ensure(claim.length >= 12, "Write the lesson as advice for future plans");
  const refs = list(findings, "Findings", 10).map((value) => {
    const ref = record(value, "Finding");
    return { sessionId: identifier(ref.sessionId, "Session ID"), requestId: identifier(ref.requestId, "Request ID"), findingId: identifier(ref.findingId, "Finding ID") };
  });
  ensure(refs.length >= 2, "A pattern needs at least two findings");
  ensure(new Set(refs.map((r) => `${r.sessionId}/${r.requestId}/${r.findingId}`)).size === refs.length, "Each finding may be cited once");
  ensure(new Set(refs.map((r) => r.sessionId)).size >= 2, "A pattern needs findings from at least two sessions; one session's findings are fixed in that session");
  const cache = new Map<string, ReviewFinding[]>();
  for (const ref of refs) {
    if (!cache.has(ref.sessionId)) cache.set(ref.sessionId, reviewFindings(loadSession(root, ref.sessionId)));
    ensure(cache.get(ref.sessionId)!.some((f) => f.requestId === ref.requestId && f.findingId === ref.findingId),
      `${ref.findingId} in request ${ref.requestId} is not an assessed, undisputed review finding of session ${ref.sessionId}`);
  }
  return proposeLesson(root, claim, refs);
}
