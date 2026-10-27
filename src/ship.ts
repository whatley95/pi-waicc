import { execFile, execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadSession, now } from "./files.ts";
import { chooseRemote, repositoryPrefix } from "./revision.ts";
import { projectRoot, snapshot } from "./source.ts";
import { readContract } from "./workflow.ts";
import { approvalIsCurrent } from "./workflow/shared.ts";
import { acceptedFindings } from "./state.ts";
import { ensure } from "./validation.ts";
import { canonicalProject, gitlabClient, gitlabProject, type GitLabCall, type GitLabHost, type GitLabProject, type OriginProbe } from "./gitlab.ts";
import type { Session, Shipped } from "./types.ts";

/**
 * /waicc-ship: a reviewed change, from READY_TO_CLOSE to a merge request. WAICC commits only the
 * files the passing code review covered, on a branch of their own, pushes it and opens the merge
 * request (GitLab) or pull request (GitHub), then closes the session. Never the main agent: a
 * human command, or an automatic run the human started with --ship.
 */
export interface ShipPlan {
  root: string;
  sessionId: string;
  remote: string;
  remoteUrl: string | null;
  provider: "gitlab" | "github";
  /** The branch the change goes on; created from the current commit when it is new. */
  branch: string;
  newBranch: boolean;
  target: string;
  /** Changed files the passing review covered, relative to the project. */
  files: string[];
  /** Other changed files in the checkout: not committed, they stay as they are. */
  leftOut: string[];
  /** Commits already on this branch and not on the target: they go out with it. */
  earlierCommits: string[];
  title: string;
  message: string;
  description: string;
  draft: boolean;
  /** Shipped before (the session was reopened, for a failed pipeline): the same branch and merge request. */
  previous: Shipped | null;
  /** The source the passing review approved; the commit changes Git's state, so closing checks against this. */
  fingerprint: string;
}
export interface ShipOptions { branch?: string; into?: string; remote?: string; draft?: boolean }

const noPrompt = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_LITERAL_PATHSPECS: "1" };
function git(root: string, args: string[], input?: string): { ok: true; out: string } | { ok: false; error: string } {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd: root, input, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 64_000_000, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...noPrompt } }) };
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || String(error)).trim().slice(0, 600) };
  }
}
/** git push and friends reach the network: without blocking Pi, and with all of git's output (GitLab replies on stderr). */
function gitAsync(root: string, args: string[], timeout = 180_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 8_000_000, env: { ...process.env, ...noPrompt } }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: `${stdout}\n${stderr}`.trim() }));
  });
}

/** Changed files in the checkout, relative to the project folder (a monorepo sub-project starts deeper). */
function changedFiles(root: string): string[] {
  const listed = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  ensure(listed.ok, `git status failed: ${listed.ok ? "" : listed.error}`);
  const prefix = repositoryPrefix(root);
  const entries = listed.out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy is followed by its old path, which changed too.
    if (entry[0] === "R" || entry[0] === "C") paths.push(entries[++i]);
  }
  return [...new Set(paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)))].sort();
}

const slug = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "change";
function validBranch(root: string, name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(name) && !name.includes("..") && git(root, ["check-ref-format", "--branch", name]).ok;
}
const exists = (root: string, ref: string) => git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", ref]).ok;

/** The remote's default branch, from what git already knows: no network here. */
function defaultBranch(root: string, remote: string): string | null {
  const head = git(root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (head.ok && head.out.trim().startsWith(`${remote}/`)) return head.out.trim().slice(remote.length + 1);
  return ["main", "master"].find((name) => exists(root, `refs/remotes/${remote}/${name}`)) ?? null;
}

/** The merge request's description: what was asked, what was built and how it was checked, from the session's own records. */
export function shipDescription(s: Session, root: string): string {
  const { contract } = readContract(root, s.id);
  const review = s.rounds.findLast((r) => r.status === "ASSESSED" && r.review?.kind === "code");
  const completion = review?.review?.kind === "code" ? review.review.completion : null;
  const reviews = s.rounds.filter((r) => r.status === "ASSESSED" && r.review?.kind === "code").length;
  const accepted = acceptedFindings(s);
  const checks = completion?.checks ?? [];
  const mark = { passed: "✅", failed: "❌", not_run: "⏭️" } as const;
  return [
    "> 🤖 **Planned, coded and reviewed by AI agents in WAICC.** A person started it and shipped it; review it as you would any change.",
    "",
    // Merging closes the issue it was planned from, on GitLab and GitHub alike.
    ...(s.issue ? [`Closes #${s.issue.number}`, ""] : []),
    "## Requirements",
    ...contract.requirements.map((r) => `- **${r.id}:** ${r.text}`),
    "",
    "## Tasks",
    ...contract.tasks.map((task) => `- **${task.id}:** ${task.title}`),
    ...(completion?.summary ? ["", "## Summary", completion.summary] : []),
    ...(checks.length ? ["", "## Checks", ...checks.map((check) => `- ${mark[check.outcome]} ${check.description}${check.outcome === "passed" ? "" : ` (${check.outcome.replace("_", " ")})`}`)] : []),
    "",
    "## Review",
    `Independent AI code review passed${reviews > 1 ? ` after ${reviews} rounds` : ""}; every finding was fixed or answered.`,
    ...(accepted.length ? ["", "Accepted unfixed:", ...accepted.map((f) => `- ${f.findingId} (${f.severity}): ${f.description} Reason: ${f.reason}`)] : []),
    "",
    `<sub>WAICC session ${s.id}.</sub>`,
  ].join("\n");
}

/** Everything /waicc-ship would do, checked before anything changes, for the human to confirm. */
export function planShip(cwd: string, id: string, options: ShipOptions = {}): ShipPlan {
  const root = projectRoot(cwd);
  const s = loadSession(root, id);
  ensure(!s.revisionReview, "This session reviews an existing change; there is nothing of yours to ship.");
  ensure(s.status === "READY_TO_CLOSE" && s.reviewApproval?.kind === "code",
    `Only a change whose whole-change code review passed can be shipped (READY_TO_CLOSE); this session is ${s.status}.`);
  const fingerprint = snapshot(root).fingerprint;
  ensure(approvalIsCurrent(s, fingerprint), "The files changed since the passing review. Request a fresh review before shipping.");
  ensure(git(root, ["rev-parse", "--git-dir"]).ok, "This project is not a Git repository, so there is nothing to commit or push.");
  const { remote, url, provider } = chooseRemote(root, options.remote);
  const review =s.rounds.findLast((r) => r.status === "ASSESSED" && r.review?.kind === "code")!;
  const reviewed = new Set(review.review?.kind === "code" ? review.review.changedPaths : []);
  const changed = changedFiles(root);
  const files = changed.filter((path) => reviewed.has(path));
  const leftOut = changed.filter((path) => !reviewed.has(path));
  const current = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  ensure(current.ok, "The checkout is not on a branch (detached HEAD). Switch to a branch first.");
  const branchNow = current.out.trim();
  const previous = s.shipped ?? null;
  const target = options.into ?? previous?.target ?? defaultBranch(root, remote);
  ensure(target, `Could not tell ${remote}'s default branch; name the target with --into <branch>`);
  ensure(validBranch(root, target), `Not a branch name: ${JSON.stringify(target)}`);
  const { contract } = readContract(root, id);
  const named = `waicc/${s.issue ? `${s.issue.number}-` : ""}${slug(contract.title)}`;
  let branch = options.branch ?? previous?.branch ?? (branchNow !== target ? branchNow : named);
  ensure(validBranch(root, branch), `Not a branch name: ${JSON.stringify(branch)}`);
  ensure(branch !== target, `The change would go straight onto ${target}. Ship it on its own branch: drop --branch, or name another.`);
  const newBranch = branch !== branchNow;
  if (newBranch && !options.branch && !previous && exists(root, `refs/heads/${branch}`))
    for (let n = 2; exists(root, `refs/heads/${branch}`); n++) branch = `${named}-${n}`;
  ensure(!newBranch || !exists(root, `refs/heads/${branch}`),
    `Branch ${branch} already exists. Switch to it yourself (git switch ${branch}) if the change belongs there, or pass --branch with a new name.`);
  const base = exists(root, `refs/remotes/${remote}/${target}`) ? `refs/remotes/${remote}/${target}` : null;
  const log = base ? git(root, ["log", "--format=%h %s", "-n", "20", `${base}..HEAD`]) : null;
  const earlierCommits = log?.ok ? log.out.split(/\r?\n/).filter(Boolean) : [];
  ensure(files.length || earlierCommits.length, "Nothing to ship: the reviewed files have no uncommitted changes, and the branch has no commits the target lacks.");
  const title = contract.title.trim().replace(/\s+/g, " ").slice(0, 200);
  return {
    root, sessionId: id, remote, remoteUrl: url, provider, branch, newBranch, target, files, leftOut, earlierCommits, title,
    message: `${title}\n\n${contract.requirements.map((r) => `- ${r.id}: ${r.text}`).join("\n")}\n\nPlanned, coded and reviewed with AI agents in WAICC (session ${id}).\n`,
    description: shipDescription(s, root), draft: Boolean(options.draft), previous, fingerprint,
  };
}

/** Where the merge request is opened: by WAICC after the push, or by the push itself (GitLab push options). */
export interface RequestOpener {
  /** git push -o options, when the remote opens the merge request itself. */
  pushOptions?: string[];
  open(plan: ShipPlan, pushOutput: string): Promise<Shipped["request"]>;
}

/** Commits the reviewed files, pushes the branch and opens the merge request. The session is closed by the caller. */
export async function ship(plan: ShipPlan, opener: RequestOpener): Promise<Shipped> {
  const { root } = plan;
  // You confirmed what the plan showed: an edit made meanwhile would ship unreviewed.
  ensure(snapshot(root).fingerprint === plan.fingerprint, "Files changed after the plan was made, so nothing was committed. Request a fresh review, or undo the edit and ship again.");
  if (plan.newBranch) {
    const created = git(root, ["switch", "-c", plan.branch]);
    ensure(created.ok, `Could not create branch ${plan.branch}: ${created.ok ? "" : created.error}`);
  }
  if (plan.files.length) {
    const list = plan.files.join("\0");
    const added = git(root, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], list);
    ensure(added.ok, `git add failed: ${added.ok ? "" : added.error}`);
    const message = join(tmpdir(), `waicc-ship-${randomUUID()}.txt`);
    writeFileSync(message, plan.message);
    try {
      // Only these paths: anything else you had staged stays staged and out of this commit.
      const committed = git(root, ["commit", "--quiet", "-F", message, "--pathspec-from-file=-", "--pathspec-file-nul"], list);
      ensure(committed.ok, `git commit failed: ${committed.ok ? "" : committed.error}`);
    } finally {
      rmSync(message, { force: true });
    }
  }
  const head = git(root, ["rev-parse", "HEAD"]);
  ensure(head.ok, "Could not read the new commit");
  const push = (options: string[]) => gitAsync(root, ["push", "--set-upstream", ...options.flatMap((option) => ["-o", option]), "--end-of-options", plan.remote, `HEAD:refs/heads/${plan.branch}`]);
  let pushed = await push(opener.pushOptions ?? []);
  // A server that is not GitLab may refuse push options: push plainly, then open the request as usual.
  if (!pushed.ok && opener.pushOptions?.length && /does not support push options/i.test(pushed.out)) pushed = await push([]);
  ensure(pushed.ok, `git push to ${plan.remote} failed; the commit is on ${plan.branch} here. ${pushed.out.split(/\r?\n/).filter((line) => !/^\s*$/.test(line)).slice(-4).join(" ")}`);
  let request: Shipped["request"];
  try {
    request = await opener.open(plan, pushed.out);
  } catch (error) {
    request = { number: null, url: null, how: "none", note: `The branch was pushed, but the merge request was not opened: ${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    shippedAt: now(), remote: plan.remote, provider: plan.provider, branch: plan.branch, target: plan.target,
    commit: head.out.trim(), files: plan.files, request, reviewedFingerprint: plan.fingerprint,
  };
}

/** The merge request GitLab reports after a push ("View merge request …" or one created by push options). */
export function pushedRequestUrl(output: string): { number: number; url: string } | null {
  const m = /(https?:\/\/\S+\/-\/merge_requests\/(\d+))(?!\/)/.exec(output);
  return m ? { number: Number(m[2]), url: m[1] } : null;
}

/** GitLab push options that open the merge request without a token: a title only, since an option is one line. */
export function gitlabPushOptions(plan: ShipPlan): string[] {
  const oneLine = (text: string) => text.replace(/[\r\n]+/g, " ").slice(0, 250);
  return [
    "merge_request.create", `merge_request.target=${plan.target}`, "merge_request.remove_source_branch",
    `merge_request.title=${oneLine(`${plan.draft ? "Draft: " : ""}${plan.title}`)}`,
    `merge_request.description=${oneLine(`${/^Closes #\d+$/m.exec(plan.description)?.[0].concat(". ") ?? ""}Planned, coded and reviewed by AI agents in WAICC (session ${plan.sessionId}). Set up a GitLab token for WAICC to get the full summary here.`)}`,
  ];
}

/** How the merge request gets opened for this remote: GitLab's API with your token, GitLab push options without one, or gh. */
export async function requestOpener(plan: ShipPlan, deps: {
  /** Your settings for a GitLab host listed in your user file: a token is sent only to such a host. */
  host: (name: string) => GitLabHost | null;
  gitlab?: (project: GitLabProject, host: GitLabHost) => GitLabCall;
  origin?: OriginProbe;
  github?: (plan: ShipPlan) => Promise<Shipped["request"]>;
}): Promise<RequestOpener> {
  if (plan.provider === "github") return { open: (p) => (deps.github ?? githubRequest)(p) };
  let project: GitLabProject | null = null;
  try {
    project = plan.remoteUrl ? gitlabProject(plan.remoteUrl) : null;
  } catch { /* not a GitLab project address: the branch is pushed and nothing more */ }
  if (!project)
    return { open: async () => ({ number: null, url: null, how: "none", note: `${plan.remote} is not a GitLab or GitHub project WAICC can open a merge request on; open it yourself.` }) };
  const found = await (deps.origin ?? canonicalProject)(project);
  const host = deps.host(found.host);
  if (host?.token) {
    const call = (deps.gitlab ?? gitlabClient)(found, host);
    return { open: (p) => gitlabRequest(call, p) };
  }
  // No token: GitLab itself opens it from the push, with a title and a one-line description.
  return {
    pushOptions: plan.previous ? [] : gitlabPushOptions(plan),
    open: async (_p, output) => {
      const opened = pushedRequestUrl(output);
      return opened
        ? { ...opened, how: plan.previous ? "existing" : "push-options", note: plan.previous ? null : `Opened without a GitLab token, so with a short description. For WAICC's full summary next time, list ${found.host} under "gitlab" in your user file (/waicc-mr-comments walks you through it).` }
        : { number: null, url: null, how: "none", note: "The branch was pushed, but GitLab did not report a merge request. Open one on GitLab." };
    },
  };
}

/** GitLab's API opens the merge request with the full description, or finds the one already open for the branch. */
export async function gitlabRequest(call: GitLabCall, plan: ShipPlan): Promise<Shipped["request"]> {
  const open = await call("GET", `/merge_requests?state=opened&source_branch=${encodeURIComponent(plan.branch)}&target_branch=${encodeURIComponent(plan.target)}`);
  if (Array.isArray(open) && open[0]?.iid) return { number: Number(open[0].iid), url: String(open[0].web_url ?? ""), how: "existing", note: "The merge request was already open; the push updated it." };
  const mr = await call("POST", "/merge_requests", {
    source_branch: plan.branch, target_branch: plan.target, title: `${plan.draft ? "Draft: " : ""}${plan.title}`,
    description: plan.description, remove_source_branch: true,
  });
  return { number: Number(mr?.iid) || null, url: mr?.web_url ? String(mr.web_url) : null, how: "api", note: null };
}

/** gh opens the pull request; without gh, the page to open it by hand. */
export async function githubRequest(plan: ShipPlan): Promise<Shipped["request"]> {
  const run = (args: string[], input?: string) => new Promise<{ ok: boolean; out: string }>((resolve) => {
    const child = execFile("gh", args, { cwd: plan.root, encoding: "utf8", windowsHide: true, timeout: 120_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: error ? `${stderr || error.message}`.trim() : stdout.trim() }));
    if (input !== undefined) child.stdin?.end(input);
  });
  const compare = (() => {
    const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(plan.remoteUrl ?? "");
    return m ? `https://github.com/${m[1]}/compare/${encodeURIComponent(plan.target)}...${encodeURIComponent(plan.branch)}?expand=1` : null;
  })();
  const existing = await run(["pr", "view", plan.branch, "--json", "url,number,state"]);
  const found = existing.ok ? (JSON.parse(existing.out) as { url: string; number: number; state: string }) : null;
  if (found?.state === "OPEN") return { number: found.number, url: found.url, how: "existing", note: "The pull request was already open; the push updated it." };
  const created = await run(["pr", "create", "--base", plan.target, "--head", plan.branch, "--title", plan.title, "--body-file", "-", ...(plan.draft ? ["--draft"] : [])], plan.description);
  if (created.ok) {
    const url = created.out.split(/\r?\n/).find((line) => /^https:\/\/\S+\/pull\/\d+/.test(line.trim()))?.trim() ?? null;
    return { number: url ? Number(/\/pull\/(\d+)/.exec(url)![1]) : null, url, how: "gh", note: null };
  }
  return { number: null, url: compare, how: "none", note: `gh could not open the pull request (${created.out.split(/\r?\n/)[0].slice(0, 200)}). ${compare ? `Open it here: ${compare}` : "Open it on GitHub."}` };
}
