import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { initialize, listSessions, runtimePath } from "./files.ts";
import { projectRoot } from "./source.ts";
import { ensure } from "./validation.ts";

/**
 * One folder per branch with `git worktree`: in a monorepo, switching branch switches every
 * service, so each branch gets its own folder instead, sharing one repository. WAICC's sessions
 * live inside each folder, so each branch keeps its own sessions and tracker card.
 */
export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  main: boolean;
  /** WAICC's own temporary folder for a delegated coding run; never removed from here. */
  waicc: boolean;
  locked: boolean;
}

const git = (cwd: string, args: string[], timeout = 60_000): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 16_000_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const tryGit = (cwd: string, args: string[]): string | null => {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
};
const failure = (error: unknown): string => {
  const e = error as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(error)).trim().split("\n").filter(Boolean).at(-1)?.replace(/^fatal:\s*/, "") ?? String(error);
};
const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const native = (path: string) => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

export function worktrees(cwd: string): Worktree[] {
  const out = tryGit(cwd, ["worktree", "list", "--porcelain"]);
  ensure(out !== null, "This folder is not in a Git repository, so it has no branch folders");
  const temporary = native(tmpdir());
  return out.split(/\r?\n\r?\n/).filter((block) => block.trim()).map((block, i) => {
    const line = (key: string) => block.split(/\r?\n/).find((l) => l === key || l.startsWith(`${key} `))?.slice(key.length + 1);
    const path = native(line("worktree") ?? "");
    return {
      path, head: line("HEAD") ?? "", branch: line("branch")?.replace(/^refs\/heads\//, "") ?? null, main: i === 0,
      waicc: basename(path).startsWith("waicc-worktree-") && same(dirname(path), temporary),
      locked: line("locked") !== undefined,
    };
  });
}

/** Where this chat stands: its branch folder, and the project folder inside it (a service in a monorepo). */
export function here(cwd: string) {
  const top = native(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
  const project = native(projectRoot(cwd));
  const inside = relative(top, project);
  return { top, project, inside: inside.startsWith("..") ? "" : inside, initialized: existsSync(join(project, runtimePath)) && !same(project, top) };
}

const slug = (branch: string) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "branch";

/**
 * A folder for the branch: the local branch if there is one, else the remote's (tracking it),
 * else a new branch from `from` or the remote's default branch. A service set up with
 * /waicc-init is set up the same way in the new folder. Returns where to start Pi.
 */
export function addWorktree(cwd: string, branch: string, options: { from?: string; path?: string } = {}) {
  const checked = tryGit(cwd, ["check-ref-format", "--branch", branch]);
  ensure(checked !== null && !branch.startsWith("-"), `Not a branch name: ${JSON.stringify(branch)}`);
  const list = worktrees(cwd), main = list[0];
  const busy = list.find((w) => w.branch === branch);
  ensure(!busy, `${branch} already has its folder: ${busy?.path}. Start Pi there.`);
  const path = options.path ?? join(dirname(main.path), `${basename(main.path)}-${slug(branch)}`);
  ensure(!existsSync(path), `${path} already exists; pick another folder with --path`);
  const at = here(cwd);
  const hasRef = (ref: string) => tryGit(cwd, ["show-ref", "--verify", "--quiet", ref]) !== null;
  const remotes = (tryGit(cwd, ["remote"]) ?? "").split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  const remote = remotes.find((r) => hasRef(`refs/remotes/${r}/${branch}`));
  let kind: "existing" | "tracking" | "new", base: string | null = null;
  try {
    if (hasRef(`refs/heads/${branch}`)) {
      kind = "existing";
      git(cwd, ["worktree", "add", "--quiet", path, branch]);
    } else if (remote && !options.from) {
      kind = "tracking";
      base = `${remote}/${branch}`;
      git(cwd, ["worktree", "add", "--quiet", "--track", "-b", branch, path, base]);
    } else {
      kind = "new";
      const origin = remotes.includes("origin") ? "origin" : remotes[0];
      const defaultBranch = origin ? tryGit(cwd, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${origin}/HEAD`])?.trim() : undefined;
      base = options.from ?? defaultBranch ?? "HEAD";
      ensure(tryGit(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`]) !== null, `No branch or commit ${JSON.stringify(base)} to start ${branch} from`);
      git(cwd, ["worktree", "add", "--quiet", "--no-track", "-b", branch, path, base]);
    }
  } catch (error) {
    throw new Error(`git worktree add failed: ${failure(error)}`);
  }
  const folder = at.inside ? join(path, at.inside) : path;
  // A service's WAICC set-up is not in Git, so the new folder gets it too.
  if (at.initialized && existsSync(folder)) initialize(folder);
  return { path: native(path), branch, kind, base, startIn: native(existsSync(folder) ? folder : path), initialized: at.initialized && existsSync(folder) };
}

/** What a branch folder holds that removing it would lose or leave behind. */
export function worktreeState(w: Worktree, inside = "") {
  const status = tryGit(w.path, ["status", "--porcelain"]);
  const changed = status === null ? null : status.split(/\r?\n/).filter(Boolean).length;
  const upstream = tryGit(w.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?.trim();
  const ahead = tryGit(w.path, upstream ? ["rev-list", "--count", `${upstream}..HEAD`] : ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  const roots = [...new Set([w.path, inside ? join(w.path, inside) : w.path])];
  const sessions = roots.reduce((n, root) => {
    try {
      return n + (existsSync(join(root, runtimePath)) ? listSessions(root).filter((s) => s.status !== "CLOSED").length : 0);
    } catch {
      return n;
    }
  }, 0);
  return { changed, unpushed: ahead === null ? null : Number(ahead.trim()), upstream: upstream ?? null, openSessions: sessions };
}

/** Removes a branch folder Git can remove cleanly; the branch itself is kept. */
export function removeWorktree(cwd: string, target: string) {
  const list = worktrees(cwd);
  const w = list.find((x) => x.branch === target || same(x.path, native(target)));
  ensure(w, `No branch folder for ${JSON.stringify(target)}; /waicc-worktree lists them`);
  ensure(!w.main, "That is the repository's main folder; it is never removed from here");
  ensure(!w.waicc, "That is WAICC's temporary folder for a delegated coding run; it is removed when the run ends");
  ensure(!w.locked, `${w.path} is locked; unlock it with git worktree unlock first`);
  ensure(!same(w.path, here(cwd).top), "This chat is working in that folder; run /waicc-worktree remove from another folder");
  try {
    git(cwd, ["worktree", "remove", w.path]);
  } catch (error) {
    throw new Error(`git worktree remove failed: ${failure(error)}`);
  }
  return w;
}
