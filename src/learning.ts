import { loadSession } from "./files.ts";
import { overlap, projectSessions, reviewFindings, words, type ReviewFinding } from "./history.ts";
import { memoryStates, proposeLesson, strengthenLesson } from "./memory.ts";
import { projectRoot } from "./source.ts";
import { ensure, identifier, list, record, text } from "./validation.ts";
import type { MemoryEntry } from "./types.ts";

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
  const earlier = projectSessions(root, sessionId).flatMap(reviewFindings)
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
    instruction: "LEARN ACROSS SESSIONS: earlier sessions in this project had review findings that may resemble this review's (most similar first; the score only counts shared words). If one of this review's findings is genuinely the same kind of problem as one or more earlier findings (same root cause or the same missing practice, not just similar words), call waicc_learn_pattern once for that pattern: a short lesson for future plans saying what to plan or check up front, and the findings it rests on (this review's finding and the earlier ones). If an existing lesson already covers the pattern, strengthen it instead: call waicc_learn_pattern with its lessonId and only this review's findings, since the same problem in another session is more support for it. Skip one-off problems. A lesson is only a candidate until the human confirms it with /waicc-memory confirm; tell them you proposed it.",
  };
}

/**
 * Validates the cited findings, then proposes the lesson for the human to confirm, or, with
 * lessonId, adds them to an existing lesson as the same pattern found in another session.
 */
export function learnPattern(cwd: string, lesson: unknown, findings: unknown, lessonId?: string): MemoryEntry {
  const root = projectRoot(cwd);
  const refs = list(findings, "Findings", 10).map((value) => {
    const ref = record(value, "Finding");
    return { sessionId: identifier(ref.sessionId, "Session ID"), requestId: identifier(ref.requestId, "Request ID"), findingId: identifier(ref.findingId, "Finding ID") };
  });
  ensure(new Set(refs.map((r) => `${r.sessionId}/${r.requestId}/${r.findingId}`)).size === refs.length, "Each finding may be cited once");
  const claim = lessonId ? "" : text(lesson, "Lesson", 600).trim();
  if (!lessonId) {
    ensure(claim.length >= 12, "Write the lesson as advice for future plans");
    ensure(refs.length >= 2, "A pattern needs at least two findings");
    ensure(new Set(refs.map((r) => r.sessionId)).size >= 2, "A pattern needs findings from at least two sessions; one session's findings are fixed in that session");
  } else ensure(refs.length >= 1, "Cite the new findings that show the pattern again");
  const cache = new Map<string, ReviewFinding[]>();
  for (const ref of refs) {
    if (!cache.has(ref.sessionId)) cache.set(ref.sessionId, reviewFindings(loadSession(root, ref.sessionId)));
    ensure(cache.get(ref.sessionId)!.some((f) => f.requestId === ref.requestId && f.findingId === ref.findingId),
      `${ref.findingId} in request ${ref.requestId} is not an assessed, undisputed review finding of session ${ref.sessionId}`);
  }
  return lessonId ? strengthenLesson(root, lessonId, refs) : proposeLesson(root, claim, refs);
}
