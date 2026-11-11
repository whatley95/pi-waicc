import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePath } from "./files.ts";

/**
 * What a code review saw of its changed files, kept so the next review can be told exactly what
 * changed since: a follow-up reviewer otherwise re-reads every file to find the fixes (follow-ups
 * cost as much as first reviews in the user's runs). Text files only, within limits; a file left
 * out is reviewed whole next time, as before.
 */
const fileLimit = 256 * 1024;
const totalLimit = 4 * 1024 * 1024;
/** Most characters of the follow-up's patch; past it the reviewer reads the remaining files whole. */
export const patchLimit = 200_000;

/** Copies of the changed text files as the review sees them, by project-relative path. */
export function reviewedCopies(root: string, paths: string[]): Record<string, string> {
  const copies: Record<string, string> = {};
  let total = 0;
  for (const path of paths) {
    let full: string;
    try {
      full = safePath(root, path);
    } catch {
      continue;
    }
    if (!existsSync(full)) continue;
    const size = statSync(full).size;
    if (size > fileLimit || total + size > totalLimit) continue;
    const bytes = readFileSync(full);
    // A NUL byte early on: binary, which a diff cannot show.
    if (bytes.subarray(0, 8192).includes(0)) continue;
    copies[path] = bytes.toString("utf8");
    total += size;
  }
  return copies;
}

/** One file's unified diff from `before` to `after` (null: absent), headed by its project path. */
function fileDiff(path: string, before: string | null, after: string | null): string | null {
  const folder = mkdtempSync(join(tmpdir(), "waicc-diff-"));
  try {
    const a = join(folder, "a"), b = join(folder, "b");
    writeFileSync(a, before ?? "");
    writeFileSync(b, after ?? "");
    const ran = spawnSync("git", ["diff", "--no-index", "--no-color", "-U3", a, b], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (ran.status !== 1 || !ran.stdout) return null; // 0: no difference; anything else: no diff to give.
    const hunks = ran.stdout.slice(ran.stdout.indexOf("@@"));
    return `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ ${after === null ? "/dev/null" : `b/${path}`}\n${hunks.endsWith("\n") ? hunks : `${hunks}\n`}`;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * What changed in `paths` since the earlier review: one patch, from the copies that review kept
 * (`earlier(path)`, undefined when it kept none) to the files now. A path the earlier review kept
 * no copy of, and that existed then, is `unavailable`: the reviewer reads it whole.
 */
export function changesSinceReview(root: string, paths: string[], earlier: (path: string) => string | undefined, existedThen: (path: string) => boolean):
  { patch: string; paths: number; unavailable: string[]; truncated: boolean } {
  let patch = "", shown = 0, truncated = false;
  const unavailable: string[] = [];
  for (const path of paths) {
    const before = earlier(path) ?? (existedThen(path) ? undefined : null);
    if (before === undefined) {
      unavailable.push(path);
      continue;
    }
    let full: string | null = null;
    try {
      full = safePath(root, path);
    } catch { /* outside the project: nothing to show */ }
    let after: string | null = null;
    if (full && existsSync(full)) {
      const bytes = readFileSync(full);
      if (bytes.length > fileLimit || bytes.subarray(0, 8192).includes(0)) {
        unavailable.push(path);
        continue;
      }
      after = bytes.toString("utf8");
    }
    const diff = fileDiff(path, before, after);
    if (diff === null) {
      if (before !== after) unavailable.push(path);
      continue;
    }
    if (patch.length + diff.length > patchLimit) {
      truncated = true;
      unavailable.push(path);
      continue;
    }
    patch += diff;
    shown++;
  }
  return { patch, paths: shown, unavailable, truncated };
}
