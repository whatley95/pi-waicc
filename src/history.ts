import { existsSync, readdirSync } from "node:fs";
import { loadSession, runtimePath, safePath } from "./files.ts";
import type { FindingRef, Session } from "./types.ts";

/** A review finding the main agent assessed and did not dispute: evidence of a real problem. */
export interface ReviewFinding extends FindingRef {
  sessionTitle: string;
  severity: string;
  description: string;
}

const stop = new Set("the and for with that this from are was were has have had not but all any can will should must into than then them they their there what when where which who why how use using add also only each such other its our your you out new does done when while been being more most very".split(" "));
/** Significant words, crudely stemmed, so "tests"/"testing"/"tested" meet. */
export const words = (value: string): Set<string> => new Set(value.toLowerCase().replace(/`[^`]*`/g, " ").split(/[^a-z]+/)
  .filter((word) => word.length > 2 && !stop.has(word)).map((word) => word.replace(/(ing|ed|es|s)$/, "")).filter((word) => word.length > 2));
/** Shared words over all words (Jaccard): 1 is the same words, 0 none in common. */
export const overlap = (a: Set<string>, b: Set<string>): number => {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared ? shared / (a.size + b.size - shared) : 0;
};

export function reviewFindings(s: Session): ReviewFinding[] {
  const title = s.requirements[0]?.split("\n")[0]?.slice(0, 120) ?? "Untitled";
  return s.rounds.filter((r) => r.mode === "review" && r.status === "ASSESSED" && r.reply).flatMap((r) => {
    const disputed = new Set((r.dispositions ?? []).filter((d) => d.disposition === "disputed").map((d) => d.findingId));
    return r.reply!.findings.filter((f) => !disputed.has(f.id) && f.severity !== "info")
      .map((f) => ({ sessionId: s.id, requestId: r.id, findingId: f.id, sessionTitle: title, severity: f.severity, description: f.description.slice(0, 400) }));
  });
}
/** Every readable session in the project, except one; an unreadable one is skipped. */
export function projectSessions(root: string, except?: string): Session[] {
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
