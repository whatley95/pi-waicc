import { execFile, execFileSync } from "node:child_process";
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
  /** For a large change across several top-level folders (services in a monorepo): one patch each. */
  parts: { folder: string; file: string; paths: number; truncated: boolean; patch: string }[];
}

export const maxPatchChars = 400_000;
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// A revision name, never an option: no leading "-", no spaces, quotes or shell characters.
const gitName = /^[A-Za-z0-9_][A-Za-z0-9._/~^@{}+-]*$/;

function run(program: string, args: string[], cwd: string, timeout = 60_000, env?: Record<string, string>): { ok: true; out: string } | { ok: false; error: string } {
  try {
    return { ok: true, out: execFileSync(program, args, { cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 64_000_000, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) }) };
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || String(error)).trim().split("\n")[0].slice(0, 300) };
  }
}
/** As run, without blocking Pi: for git commands that reach the network. */
function runAsync(program: string, args: string[], cwd: string, timeout: number, env: Record<string, string>): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(program, args, { cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 8_000_000, env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve(error ? { ok: false, error: (stderr || error.message).trim().split("\n")[0].slice(0, 300) } : { ok: true, out: stdout }));
  });
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

/** The project's folder inside its Git repository ("services/orders/"), or "" at the root. */
export function repositoryPrefix(root: string): string {
  const prefix = run("git", ["rev-parse", "--show-prefix"], root, 15_000);
  return prefix.ok ? prefix.out.trim() : "";
}
/** A remote's URL without any user name or password in it, for records and messages. */
export const safeRemoteUrl = (url: string): string => url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
const branchName = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

const noPrompt = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
/** The remote merge requests come from: the one named, the only one, or origin; GitHub by its URL. */
export function chooseRemote(root: string, wanted?: string): { remote: string; url: string | null; provider: "gitlab" | "github" } {
  const remotes = run("git", ["remote"], root, 15_000);
  ensure(remotes.ok, "This project is not a Git repository, so there is no merge request to fetch");
  const names = remotes.out.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  ensure(names.length > 0, "This repository has no remote to fetch the merge request from");
  const remote = wanted ?? (names.length === 1 ? names[0] : names.includes("origin") ? "origin" : undefined);
  ensure(remote, `This repository has several remotes; pick one with --remote <name>: ${names.join(", ")}`);
  ensure(names.includes(remote), `No remote named ${JSON.stringify(remote)}; remotes here: ${names.join(", ")}`);
  const url = run("git", ["remote", "get-url", remote], root, 15_000);
  const remoteUrl = url.ok ? safeRemoteUrl(url.out) : null;
  return { remote, url: remoteUrl, provider: remoteUrl && /github\.com[:/]/i.test(remoteUrl) ? "github" : "gitlab" };
}
/**
 * The merge requests a remote publishes, newest number first, from plain git (no token). Git
 * cannot tell open from merged or closed ones: GitLab keeps every merge request's ref.
 */
export async function remoteMergeRequests(root: string, wanted?: string, limit = 30): Promise<{ number: number; head: string }[]> {
  const { remote, provider } = chooseRemote(root, wanted);
  const pattern = provider === "github" ? "refs/pull/*/head" : "refs/merge-requests/*/head";
  const listed = await runAsync("git", ["ls-remote", "--end-of-options", remote, pattern], root, 60_000, noPrompt);
  ensure(listed.ok, `git ls-remote ${remote} failed: ${listed.ok ? "" : listed.error}`);
  return listed.out.split(/\r?\n/).flatMap((line) => {
    const m = /^([0-9a-f]{40,64})\s+refs\/(?:merge-requests|pull)\/(\d+)\/head$/.exec(line.trim());
    return m ? [{ number: Number(m[2]), head: m[1] }] : [];
  }).sort((a, b) => b.number - a.number).slice(0, limit);
}

/**
 * Fetches a merge request (GitLab) or pull request (GitHub) and its target branch with plain
 * git, into WAICC's own refs (refs/waicc/mr/<n>/…): your branches and working folder are not
 * touched, and no token is needed. Git never prompts for a password here, so a missing login
 * fails instead of hanging. The range is the MR's diff: from the merge base to its head.
 */
export async function fetchMergeRequest(root: string, input: string, options: { remote?: string; into?: string } = {}): Promise<RevisionReview> {
  const m = /^[!#]?(\d{1,9})$/.exec(input.trim());
  ensure(m && Number(m[1]) > 0, `A merge request is its number, like 123 or !123, not ${JSON.stringify(input)}`);
  const number = Number(m[1]);
  const { remote, url: remoteUrl, provider } = chooseRemote(root, options.remote);
  let target = options.into;
  if (!target) {
    const local = run("git", ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], root, 15_000);
    if (local.ok && local.out.trim().startsWith(`${remote}/`)) target = local.out.trim().slice(remote.length + 1);
    else {
      const remoteHead = await runAsync("git", ["ls-remote", "--symref", remote, "HEAD"], root, 60_000, noPrompt);
      target = remoteHead.ok ? /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(remoteHead.out)?.[1] : undefined;
    }
    ensure(target, `Could not tell ${remote}'s default branch; name the target with --into <branch>`);
  }
  ensure(branchName.test(target) && !target.includes(".."), `Not a branch name: ${JSON.stringify(target)}`);
  const source = provider === "github" ? `refs/pull/${number}/head` : `refs/merge-requests/${number}/head`;
  const head = `refs/waicc/mr/${number}/head`, into = `refs/waicc/mr/${number}/target`;
  const fetched = await runAsync("git", ["fetch", "--no-tags", "--quiet", "--end-of-options", remote, `+${source}:${head}`, `+refs/heads/${target}:${into}`], root, 180_000, noPrompt);
  ensure(fetched.ok, fetched.ok ? "" : /couldn't find remote ref/i.test(fetched.error)
    ? `${remote} has no ${provider === "github" ? "pull" : "merge"} request ${provider === "github" ? "#" : "!"}${number} (${source}) or no branch ${target}`
    : `git fetch from ${remote} failed: ${fetched.error}`);
  const to = gitCommit(root, head), tip = gitCommit(root, into);
  const base = run("git", ["merge-base", tip, to], root, 15_000);
  ensure(base.ok, `Merge request ${number} shares no history with ${target}`);
  const from = base.out.trim();
  ensure(from !== to, `Merge request ${number} has no changes against ${target}`);
  const sign = provider === "github" ? "#" : "!";
  return {
    vcs: "git", range: `${sign}${number}`, from, to,
    label: `merge request ${sign}${number} into ${target} (${short(from)}..${short(to)})`,
    mergeRequest: { remote, number, provider, target, url: remoteUrl, head: to },
  };
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
  const changedPaths = [...new Set(names)].sort();
  const cut = (text: string) => (text.length > maxPatchChars
    ? `${text.slice(0, maxPatchChars)}\n\n[WAICC: patch cut at ${maxPatchChars} characters of ${text.length}. Read the remaining changed files listed in code-review.json from the checkout or history.]\n` : text);
  // Once a change is large and spans several folders, each folder gets its own patch. The
  // folders are taken at the first depth where the change splits, so services/orders and
  // services/status are two parts, not one "services".
  const groupAt = (depth: number) => {
    const groups = new Map<string, string[]>();
    for (const path of changedPaths) {
      const segments = path.split("/");
      const key = segments.length > depth ? segments.slice(0, depth).join("/") : "(other files)";
      groups.set(key, [...(groups.get(key) ?? []), path]);
    }
    return groups;
  };
  let depth = 1, folders = groupAt(1);
  while (folders.size === 1 && depth < 4 && !folders.has("(other files)")) folders = groupAt(++depth);
  const parts: RevisionChanges["parts"] = [];
  if (r.vcs === "git" && folders.size > 1 && folders.size <= 30 && patch.length > 100_000)
    for (const [folder, paths] of folders) {
      const pathspec = folder === "(other files)" ? paths.slice(0, 200).map((path) => `:(literal)${path}`) : [`:(literal)${folder}/`];
      const part = run("git", ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--relative", "-M", r.from, r.to, "--", ...pathspec], root);
      if (!part.ok || !part.out) continue;
      const file = `${folder === "(other files)" ? "_other-files" : folder.replace(/[^A-Za-z0-9._-]/g, "_")}.patch`;
      parts.push({ folder, file, paths: paths.length, truncated: part.out.length > maxPatchChars, patch: cut(part.out) });
    }
  return {
    changedPaths,
    patch: cut(patch),
    commits: commits.slice(0, 100_000),
    truncated: patch.length > maxPatchChars,
    patchBytes: patch.length,
    parts,
  };
}
