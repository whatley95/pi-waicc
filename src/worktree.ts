import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { safePath } from "./files.ts";
import { assertTaskPath } from "./recipient.ts";
import { gitPrefix, snapshot } from "./source.ts";
import { ensure } from "./validation.ts";
import type { RecipientPin } from "./types.ts";

/** An isolated copy where an external agent can code without touching the checkout. */
export interface Isolation {
  worktree: string;
  /** The project inside the worktree: the worktree itself, or a sub-project's folder in it. */
  workdir?: string;
  /** The project's path inside its repository ("" at the top; "services/status/" for a sub-project). */
  prefix?: string;
  /** Commit holding exactly the handoff's fingerprinted files; on no branch. */
  base: string;
  /** Checkout fingerprint at creation; changes are applied only if it still matches. */
  source: string;
  /** Ignored dependency folders linked from the checkout, so checks can run in the copy. */
  linked: string[];
}
/** Top-level dependency folders worth linking when Git ignores them; never copied or applied. */
const dependencyFolders = ["node_modules", ".venv", "venv"];
export interface Change {
  status: "A" | "M" | "D";
  path: string;
}

function git(cwd: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync("git", args, {
    cwd, input: options.input, env: { ...process.env, ...options.env, GIT_LITERAL_PATHSPECS: "1" },
    encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024,
  });
}

/** Snapshots the working files through a temporary index, so the checkout and its index stay untouched. */
export function createIsolation(root: string, id: string): Isolation {
  const source = snapshot(root);
  ensure(source.vcs === "git", "Isolated implementation needs a Git checkout. Use --via pi, or hand it off manually.");
  const prefix = gitPrefix(root) ?? "";
  const head = (() => {
    try {
      return git(root, ["rev-parse", "--verify", "HEAD"]).trim();
    } catch {
      return null; // A repository without commits yet.
    }
  })();
  const index = join(tmpdir(), `waicc-index-${id}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    // A sub-project gets the rest of the repository as last committed, so builds that use
    // shared modules still work, and its own files exactly as the handoff saw them.
    git(root, ["read-tree", prefix && head ? head : "--empty"], { env });
    if (prefix) git(root, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", "."], { env });
    const paths = Object.keys(source.files);
    // Exactly the fingerprinted files, including uncommitted and untracked ones; --force keeps tracked ignored files.
    if (paths.length) git(root, ["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: paths.join("\0") });
    const tree = git(root, ["write-tree"], { env }).trim();
    const ident = { GIT_AUTHOR_NAME: "WAICC", GIT_AUTHOR_EMAIL: "waicc@localhost", GIT_COMMITTER_NAME: "WAICC", GIT_COMMITTER_EMAIL: "waicc@localhost" };
    const base = git(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "WAICC dispatch snapshot"], { env: ident }).trim();
    // Long, physical path: agents (Claude Code) refuse to edit under Windows 8.3 short names
    // such as C:\Users\NAME~1, which os.tmpdir() can return.
    const worktree = join(realpathSync.native(tmpdir()), `waicc-worktree-${id}`);
    // No checkout: copying the checkout's own bytes keeps the copy identical whatever the
    // line-ending settings (core.autocrlf would otherwise rewrite them).
    git(root, ["worktree", "add", "--detach", "--no-checkout", "--quiet", worktree, base]);
    git(worktree, ["reset", "--quiet"]);
    // The rest of a monorepo is checked out normally; it is context, never applied back.
    if (prefix) git(worktree, ["checkout", "--quiet", "--", "."]);
    const workdir = join(worktree, prefix.replace(/\/$/, ""));
    for (const path of paths) {
      mkdirSync(dirname(join(workdir, path)), { recursive: true });
      copyFileSync(join(root, path), join(workdir, path));
    }
    return { worktree, workdir, prefix, base, source: source.fingerprint, linked: linkDependencies(root, workdir) };
  } finally {
    rmSync(index, { force: true });
  }
}

/** Links the checkout's ignored dependency folders into a copy, so checks can run there; returns their names. */
function linkDependencies(root: string, workdir: string): string[] {
  const linked: string[] = [];
  for (const name of dependencyFolders) {
    const target = join(root, name);
    if (!existsSync(target) || !lstatSync(target).isDirectory() || existsSync(join(workdir, name))) continue;
    // Only ignored folders: anything tracked or unignored is already in the copy.
    if (spawnSync("git", ["check-ignore", "-q", name], { cwd: root, windowsHide: true }).status !== 0) continue;
    symlinkSync(target, join(workdir, name), process.platform === "win32" ? "junction" : "dir");
    linked.push(name);
  }
  return linked;
}

/** The commit a review covers, checked out read-only for its reviewer when the working folder is at another commit. */
export interface ReviewCheckout {
  worktree: string;
  /** The project inside it: the worktree itself, or a sub-project's folder in it. */
  workdir: string;
  commit: string;
  linked: string[];
}
// Git keeps a lock's reason: it names the process reading the checkout and where its project is,
// so a checkout left by a Pi that closed mid-review can be found and removed safely.
const reviewLock = (prefix: string) => `WAICC review in process ${process.pid} for ${prefix || "."}`;
const reviewLockPattern = /^WAICC review in process (\d+) for (.+)$/;

export function createReviewCheckout(root: string, id: string, commit: string): ReviewCheckout {
  try {
    sweepReviewCheckouts(root);
  } catch { /* a leftover never stops a review */ }
  const prefix = gitPrefix(root) ?? "";
  // Long, physical path, as for an isolated copy.
  const worktree = join(realpathSync.native(tmpdir()), `waicc-review-${id}`);
  // Locked while it is read, so /waicc-worktree and git worktree prune leave it alone.
  git(root, ["worktree", "add", "--detach", "--quiet", "--lock", "--reason", reviewLock(prefix), worktree, commit]);
  const workdir = join(worktree, prefix.replace(/\/$/, ""));
  return { worktree, workdir, commit, linked: linkDependencies(root, workdir) };
}

/** A review checkout is only read, so it always goes; a failure to remove it never fails the run. */
export function removeReviewCheckout(root: string, checkout: Pick<ReviewCheckout, "worktree" | "workdir" | "linked">): void {
  try {
    removeIsolation(root, checkout, { locked: true });
  } catch { /* still locked by this process, so a later review in this repository removes it */ }
}

/**
 * Removes review checkouts whose process has ended: a Pi closed during a review leaves its
 * checkout, which nothing else reads. One held by a running process (another Pi) stays.
 */
export function sweepReviewCheckouts(root: string): number {
  const temporary = realpathSync.native(tmpdir());
  let removed = 0;
  for (const block of git(root, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/)) {
    const field = (key: string) => block.split(/\r?\n/).find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
    const worktree = field("worktree");
    const lock = reviewLockPattern.exec(field("locked") ?? "");
    if (!worktree || !lock || !basename(worktree).startsWith("waicc-review-") || !samePath(dirname(worktree), temporary) || !ended(Number(lock[1]))) continue;
    const workdir = join(worktree, lock[2] === "." ? "" : lock[2]);
    removeReviewCheckout(root, { worktree, workdir, linked: dependencyFolders.filter((name) => isLink(join(workdir, name))) });
    if (!existsSync(worktree)) removed++;
  }
  return removed;
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

/** Only a process that no longer exists has let go; any doubt (another user's process) keeps the checkout. */
function ended(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Every file the agent added, changed or deleted relative to the snapshot; ignored output is left out. */
export function isolatedChanges(isolation: Isolation): Change[] {
  git(isolation.worktree, ["add", "-A"]);
  const fields = git(isolation.worktree, ["diff", "--cached", "--name-status", "--no-renames", "-z", isolation.base]).split("\0").filter(Boolean);
  const changes: Change[] = [];
  const prefix = isolation.prefix ?? "";
  const linkedPath = (path: string) => isolation.linked.some((name) => path === name || path.startsWith(`${name}/`));
  for (let i = 0; i < fields.length; i += 2) {
    // Paths relative to the project; a change elsewhere in a monorepo reads as ../…,
    // which the scope check reports as outside the task's allowed paths.
    const path = prefix && !fields[i + 1].startsWith(prefix) ? posix.relative(prefix, fields[i + 1]) : fields[i + 1].slice(prefix.length);
    // A linked dependency folder is the checkout's own; it is never part of the agent's work.
    if (linkedPath(path)) continue;
    const status = fields[i][0];
    ensure(status === "A" || status === "M" || status === "D", `Unsupported change ${fields[i]} for ${path}`);
    changes.push({ status, path });
  }
  return changes;
}

/** All or nothing: every path must be in task scope and the checkout unchanged since the snapshot. */
export function applyIsolatedChanges(root: string, pin: RecipientPin, isolation: Isolation, changes: Change[]): void {
  const outside = changes.filter((change) => {
    try {
      assertTaskPath(root, pin, change.path);
      return false;
    } catch {
      return true;
    }
  });
  ensure(!outside.length, `Nothing was applied: ${outside.map((change) => change.path).join(", ")} ${outside.length === 1 ? "is" : "are"} outside the task's allowed paths.`);
  ensure(snapshot(root).fingerprint === isolation.source, "Nothing was applied: the checkout changed while the agent worked.");
  // The checkout still equals the snapshot, so copying the changed files applies exactly the agent's edits.
  for (const change of changes) {
    const target = safePath(root, change.path);
    if (change.status === "D") rmSync(target, { force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(isolation.workdir ?? isolation.worktree, change.path), target);
    }
  }
}

export function removeIsolation(root: string, isolation: Pick<Isolation, "worktree" | "workdir" | "linked">, { locked = false } = {}): void {
  // Unlink dependency folders first, removing only the link, so removal can never reach the checkout's copy.
  for (const name of isolation.linked ?? []) {
    const link = join(isolation.workdir ?? isolation.worktree, name);
    if (!existsSync(link) && !isLink(link)) continue;
    if (process.platform === "win32") rmdirSync(link);
    else unlinkSync(link);
  }
  // A locked worktree (a review checkout) takes --force twice, and Git never prunes a locked one
  // whose folder is already gone, so that one is unlocked first.
  if (existsSync(isolation.worktree)) git(root, ["worktree", "remove", "--force", ...(locked ? ["--force"] : []), isolation.worktree]);
  else if (locked) git(root, ["worktree", "unlock", isolation.worktree]);
  git(root, ["worktree", "prune"]);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
