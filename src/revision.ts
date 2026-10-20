import { execFileSync } from "node:child_process";
import { ensure } from "./validation.ts";
import type { RevisionReview } from "./types.ts";

/**
 * A code review of an existing change: one Git commit, a Git range, or SVN revisions. WAICC
 * runs the diff itself and hands the reviewer the patch, so a reviewer that cannot run
 * commands (Claude and Pi recipients are read-only) still sees exactly what changed.
 */
/**
 * `range` is as the human typed it ("abc123", "main..feature/search", "r1234:r1250"); `from` and
 * `to` are resolved: commit IDs for Git (the empty tree for a root commit), revision numbers for SVN.
 */
export type RevisionRange = RevisionReview;
export interface RevisionChanges {
  changedPaths: string[];
  patch: string;
  commits: string;
  /** The patch was cut at the size limit; the reviewer is told what was left out. */
  truncated: boolean;
  patchBytes: number;
}

export const maxPatchChars = 400_000;
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// A revision name, never an option: no leading "-", no spaces, quotes or shell characters.
const gitName = /^[A-Za-z0-9_][A-Za-z0-9._/~^@{}+-]*$/;

function run(program: string, args: string[], cwd: string, timeout = 60_000): { ok: true; out: string } | { ok: false; error: string } {
  try {
    return { ok: true, out: execFileSync(program, args, { cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 64_000_000, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || String(error)).trim().split("\n")[0].slice(0, 300) };
  }
}
const short = (sha: string) => (sha === emptyTree ? "(empty)" : sha.slice(0, 10));

function gitCommit(root: string, name: string): string {
  ensure(gitName.test(name) && !name.includes(".."), `Not a Git revision name: ${JSON.stringify(name)}`);
  const found = run("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${name}^{commit}`], root, 15_000);
  ensure(found.ok && /^[0-9a-f]{40,64}$/.test(found.out.trim()), `Git has no commit ${JSON.stringify(name)} here`);
  return found.out.trim();
}

/** Checks the range against the repository now, so a typo fails before any session is made. */
export function resolveRevision(root: string, input: string, vcs: "git" | "svn" | "none"): RevisionRange {
  const range = input.trim();
  ensure(range.length > 0 && range.length <= 200, "Give the revision to review, e.g. --rev abc123, --rev main..feature or --rev r1234:r1250");
  if (vcs === "svn") {
    const m = /^r?(\d{1,9})(?::r?(\d{1,9}))?$/.exec(range);
    ensure(m, `SVN revisions look like r1234 or r1234:r1250, not ${JSON.stringify(range)}`);
    const first = Number(m[1]), last = Number(m[2] ?? m[1]);
    ensure(first >= 1 && last >= first, "An SVN range goes from an earlier revision to a later one, starting at r1");
    // r1234:r1250 means the changes made in r1234 through r1250.
    return { vcs, range, from: String(first - 1), to: String(last), label: first === last ? `r${last}` : `r${first}:r${last}` };
  }
  ensure(vcs === "git", "This project is not under Git or SVN, so there is no revision to review");
  const three = range.split("...");
  if (three.length === 2) {
    // a...b: what b added since it branched from a, as a pull request shows it.
    const to = gitCommit(root, three[1]), other = gitCommit(root, three[0]);
    const base = run("git", ["merge-base", other, to], root, 15_000);
    ensure(base.ok, `${three[0]} and ${three[1]} share no history`);
    const from = base.out.trim();
    ensure(from !== to, `${range} contains no changes`);
    return { vcs, range, from, to, label: `${short(from)}..${short(to)} (${range})` };
  }
  const two = range.split("..");
  if (two.length === 2) {
    const from = gitCommit(root, two[0]), to = gitCommit(root, two[1]);
    ensure(from !== to, `${range} contains no changes`);
    return { vcs, range, from, to, label: `${short(from)}..${short(to)} (${range})` };
  }
  ensure(two.length === 1, `Not a Git revision or range: ${JSON.stringify(range)}`);
  const to = gitCommit(root, range);
  const parent = run("git", ["rev-parse", "--verify", "--quiet", `${to}^`], root, 15_000);
  const from = parent.ok && parent.out.trim() ? parent.out.trim() : emptyTree;
  return { vcs, range, from, to, label: `commit ${short(to)}${range === to || to.startsWith(range) ? "" : ` (${range})`}` };
}

/** The patch, changed files and commit messages of the range, limited to this project's folder. */
export function revisionChanges(root: string, r: RevisionRange): RevisionChanges {
  let patch: string, names: string[], commits: string;
  if (r.vcs === "git") {
    // --relative: in a monorepo sub-project, only this project's files, with project-relative paths.
    const diff = run("git", ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--relative", "-M", r.from, r.to], root);
    ensure(diff.ok, `git diff failed: ${diff.ok ? "" : diff.error}`);
    const list = run("git", ["diff", "--name-only", "-z", "--relative", "-M", r.from, r.to], root);
    ensure(list.ok, `git diff failed: ${list.ok ? "" : list.error}`);
    const log = run("git", ["log", "--no-color", "--format=%H%x09%an%x09%ad%x09%s", "--date=short",
      ...(r.from === emptyTree ? ["-1", r.to] : [`${r.from}..${r.to}`]), "--", "."], root);
    patch = diff.out;
    names = list.out.split("\0").filter(Boolean);
    commits = log.ok ? log.out : `Commit list unavailable: ${log.error}\n`;
  } else {
    const diff = run("svn", ["diff", "-r", `${r.from}:${r.to}`], root, 120_000);
    ensure(diff.ok, `svn diff failed: ${diff.ok ? "" : diff.error}`);
    const list = run("svn", ["diff", "--summarize", "-r", `${r.from}:${r.to}`], root, 120_000);
    ensure(list.ok, `svn diff failed: ${list.ok ? "" : list.error}`);
    const log = run("svn", ["log", "-r", `${Number(r.from) + 1}:${r.to}`], root, 120_000);
    patch = diff.out;
    names = list.out.split(/\r?\n/).map((line) => line.slice(8).trim().replaceAll("\\", "/")).filter(Boolean);
    commits = log.ok ? log.out : `Log unavailable: ${log.error}\n`;
  }
  ensure(names.length > 0, `${r.label} changes no files in this project`);
  const truncated = patch.length > maxPatchChars;
  return {
    changedPaths: [...new Set(names)].sort(),
    patch: truncated ? `${patch.slice(0, maxPatchChars)}\n\n[WAICC: patch cut at ${maxPatchChars} characters of ${patch.length}. Read the remaining changed files listed in code-review.json from the checkout or history.]\n` : patch,
    commits: commits.slice(0, 100_000),
    truncated,
    patchBytes: patch.length,
  };
}
