import { overlap, projectSessions, reviewFindings, words } from "./history.ts";
import type { MemoryEntry, Session } from "./types.ts";

/**
 * When WAICC may confirm a memory candidate without the human. It never judges whether a claim
 * is true; it asks whether the claim is pinned to exact source lines and keeps being backed by
 * independent work. Every number here is a reason shown to the human.
 */
export const memoryRule = {
  /** Points a fact needs: proposed in another session (2), by a different model (2), a later passing code review of its file (1 each, at most 2), still quoted after a week (1). */
  factPoints: 4,
  /** Sessions whose review findings a lesson must rest on. */
  lessonSessions: 3,
  /** Shared-word similarity at which two texts count as being about the same thing. */
  similar: 0.5,
  ageDays: 7,
} as const;

export interface RuleVerdict {
  approved: boolean;
  /** Points so far, or sessions for a lesson; null when no count applies. */
  points: number | null;
  needed: number | null;
  /** What counts for it. */
  reasons: string[];
  /** What keeps it for the human, whatever its points. */
  blocked: string[];
}
/** What the rule reads: the other entries, the project's sessions (loaded once, only if needed), the source text. */
export interface RuleContext {
  entries: MemoryEntry[];
  sessions: () => Session[];
  source: (path: string) => string | null;
  now?: number;
}
export function ruleContext(root: string, entries: MemoryEntry[], source: (path: string) => string | null): RuleContext {
  let sessions: Session[] | undefined;
  return { entries, source, sessions: () => (sessions ??= projectSessions(root)) };
}

const clip = (value: string, size = 120) => (value.length > size ? `${value.slice(0, size - 1)}…` : value);
/** Line endings and trailing spaces do not count, so a quote survives a checkout on another system. */
const normalize = (value: string) => value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").trim();
export const quoteHolds = (content: string, quote: string): boolean => normalize(content).includes(normalize(quote));

/** Code names a claim relies on: backticked text, camelCase or snake_case words, and file paths. */
export function codeNames(claim: string): string[] {
  const names = new Set<string>();
  for (const match of claim.matchAll(/`([^`\n]{2,120})`/g)) names.add(match[1].trim());
  for (const match of claim.replace(/`[^`]*`/g, " ").matchAll(/[A-Za-z0-9_./-]+/g)) {
    const word = match[0].replace(/[.,;:-]+$/, "");
    if (/[a-z][A-Z]/.test(word) || /[A-Za-z]_[A-Za-z]/.test(word) || /\w\/\w/.test(word) || /\w\.[a-z]{1,5}$/.test(word)) names.add(word);
  }
  return [...names];
}
/** A name is in the source as written; a path is the source itself or named by its file name. */
function nameFound(name: string, source: string, content: string): boolean {
  if (content.includes(name)) return true;
  if (!/[/\\]|\.[a-z]{1,5}$/.test(name)) return false;
  const file = name.replaceAll("\\", "/").split("/").at(-1)!;
  return source.endsWith(name.replaceAll("\\", "/")) || content.includes(file);
}

/** Whether the rule would confirm this entry now, and why. Revoked and confirmed entries are judged the same way, for the audit. */
export function judge(entry: MemoryEntry, context: RuleContext): RuleVerdict {
  const reasons: string[] = [], blocked: string[] = [];
  const mine = words(entry.text);
  const revoked = context.entries.find((other) => other.id !== entry.id && other.revoked && overlap(mine, words(other.text)) >= memoryRule.similar);
  if (revoked) blocked.push(`it resembles an entry you revoked: "${clip(revoked.text)}"`);

  if (entry.decision) {
    reasons.push(`it restates decision ${entry.decision.decisionId}, which you answered with /waicc-decide`);
    return { approved: !blocked.length, points: null, needed: null, reasons, blocked };
  }
  if (entry.evidence?.length) {
    const sessions = new Set(entry.evidence.map((ref) => ref.sessionId)).size;
    reasons.push(`review findings in ${sessions} session${sessions === 1 ? "" : "s"} back it (${memoryRule.lessonSessions} needed)`);
    return { approved: !blocked.length && sessions >= memoryRule.lessonSessions, points: sessions, needed: memoryRule.lessonSessions, reasons, blocked };
  }
  if (entry.kind !== "fact") blocked.push(`only facts, your own decisions and lessons from recurring findings are confirmed automatically; this is a ${entry.kind}`);

  // Gates: exact lines it rests on, and every code name it uses really there.
  const content = context.source(entry.source);
  if (content === null) blocked.push(`its source ${entry.source} cannot be read`);
  else if (!entry.quote) blocked.push("it quotes no lines of its source");
  else if (!quoteHolds(content, entry.quote)) blocked.push(`its quoted lines are no longer in ${entry.source}`);
  if (content !== null) {
    const missing = codeNames(entry.text).filter((name) => !nameFound(name, entry.source, content));
    if (missing.length) blocked.push(`${missing.map((name) => `"${name}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} not in ${entry.source}`);
  }
  // A real problem a review found about the same thing may mean the fact is wrong.
  if (!blocked.length) {
    const finding = context.sessions().flatMap(reviewFindings).find((f) => overlap(mine, words(f.description)) >= memoryRule.similar);
    if (finding) blocked.push(`an accepted review finding is about the same thing: "${clip(finding.description)}"`);
  }

  // Points: independent support.
  let points = 0;
  const first = entry.proposedIn?.sessionId ?? null;
  const again = [...new Map((entry.corroborations ?? []).filter((c) => c.sessionId !== first).map((c) => [c.sessionId, c])).values()];
  if (again.length) {
    points += 2;
    reasons.push(`proposed again in ${again.length} other session${again.length === 1 ? "" : "s"} (+2)`);
    const models = [...new Set([entry.proposedIn?.model, ...again.map((c) => c.model)].filter((model): model is string => Boolean(model)))];
    if (models.length >= 2) {
      points += 2;
      reasons.push(`by different models: ${models.join(", ")} (+2)`);
    }
  }
  if (content !== null && entry.quote) {
    const reviewed = context.sessions().filter((s) => {
      const approval = s.reviewApproval;
      if (approval?.kind !== "code" || approval.assessedAt <= entry.createdAt) return false;
      const round = s.rounds.find((r) => r.id === approval.requestId);
      return round?.review?.kind === "code" && round.review.changedPaths.includes(entry.source);
    }).length;
    if (reviewed) {
      points += Math.min(reviewed, 2);
      reasons.push(`${reviewed} later code review${reviewed === 1 ? "" : "s"} passed with ${entry.source} changed and the quote still there (+${Math.min(reviewed, 2)})`);
    }
    const days = ((context.now ?? Date.now()) - Date.parse(entry.createdAt)) / 86_400_000;
    if (days >= memoryRule.ageDays) {
      points += 1;
      reasons.push(`proposed ${Math.floor(days)} days ago and its quoted lines are still there (+1)`);
    }
  }
  return { approved: !blocked.length && points >= memoryRule.factPoints, points, needed: memoryRule.factPoints, reasons, blocked };
}
