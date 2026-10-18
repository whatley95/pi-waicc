import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safePath } from "./files.ts";
import { assertTaskPath } from "./recipient.ts";
import { snapshot } from "./source.ts";
import { ensure } from "./validation.ts";
import type { RecipientPin } from "./types.ts";

/** An isolated copy where an external agent can code without touching the checkout. */
export interface Isolation {
  worktree: string;
  /** Commit holding exactly the handoff's fingerprinted files; on no branch. */
  base: string;
  /** Checkout fingerprint at creation; changes are applied only if it still matches. */
  source: string;
}
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
  const index = join(tmpdir(), `waicc-index-${id}`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(root, ["read-tree", "--empty"], { env });
    const paths = Object.keys(source.files);
    // Exactly the fingerprinted files, including uncommitted and untracked ones; --force keeps tracked ignored files.
    if (paths.length) git(root, ["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: paths.join("\0") });
    const tree = git(root, ["write-tree"], { env }).trim();
    const ident = { GIT_AUTHOR_NAME: "WAICC", GIT_AUTHOR_EMAIL: "waicc@localhost", GIT_COMMITTER_NAME: "WAICC", GIT_COMMITTER_EMAIL: "waicc@localhost" };
    const base = git(root, ["commit-tree", tree, ...(source.revision ? ["-p", source.revision] : []), "-m", "WAICC dispatch snapshot"], { env: ident }).trim();
    // Long, physical path: agents (Claude Code) refuse to edit under Windows 8.3 short names
    // such as C:\Users\NAME~1, which os.tmpdir() can return.
    const worktree = join(realpathSync.native(tmpdir()), `waicc-worktree-${id}`);
    // No checkout: copying the checkout's own bytes keeps the copy identical whatever the
    // line-ending settings (core.autocrlf would otherwise rewrite them).
    git(root, ["worktree", "add", "--detach", "--no-checkout", "--quiet", worktree, base]);
    for (const path of paths) {
      mkdirSync(dirname(join(worktree, path)), { recursive: true });
      copyFileSync(join(root, path), join(worktree, path));
    }
    git(worktree, ["reset", "--quiet"]);
    return { worktree, base, source: source.fingerprint };
  } finally {
    rmSync(index, { force: true });
  }
}

/** Every file the agent added, changed or deleted relative to the snapshot; ignored output is left out. */
export function isolatedChanges(isolation: Isolation): Change[] {
  git(isolation.worktree, ["add", "-A"]);
  const fields = git(isolation.worktree, ["diff", "--cached", "--name-status", "--no-renames", "-z", isolation.base]).split("\0").filter(Boolean);
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i][0];
    ensure(status === "A" || status === "M" || status === "D", `Unsupported change ${fields[i]} for ${fields[i + 1]}`);
    changes.push({ status, path: fields[i + 1] });
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
      copyFileSync(join(isolation.worktree, change.path), target);
    }
  }
}

export function removeIsolation(root: string, isolation: Isolation): void {
  if (existsSync(isolation.worktree)) git(root, ["worktree", "remove", "--force", isolation.worktree]);
  git(root, ["worktree", "prune"]);
}
