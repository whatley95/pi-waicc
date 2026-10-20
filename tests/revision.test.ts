import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { artifact, initialize, loadSession } from "../src/files.ts";
import { roundDirectory } from "../src/render.ts";
import { fetchMergeRequest, maxPatchChars, resolveRevision, revisionChanges, safeRemoteUrl } from "../src/revision.ts";
import { initProject } from "../src/source.ts";
import { assess, createRevisionReview, exportHandoff, ingest, issue, prepare } from "../src/workflow.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import type { Contract } from "../src/types.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

/** A repository with three commits: the app, a search feature, then paging. */
function repository(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "app.js"), "export const app = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Start the app");
  const first = git(root, "rev-parse", "HEAD");
  git(root, "switch", "-q", "-c", "feature/search");
  writeFileSync(join(root, "search.js"), "export function search(q) { return q.trim(); }\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Add search");
  const search = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "app.js"), "export const app = 2; // paging\n");
  git(root, "commit", "-q", "-am", "Add paging");
  const paging = git(root, "rev-parse", "HEAD");
  return { root, first, search, paging };
}

const contract = (request: string): Contract => ({
  title: "Review of search", requirements: [{ id: "R1", text: "Search trims the query", sourceQuote: request }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title: "Search", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["search.js"],
    acceptance: [{ id: "AC1", text: "Trims", requirementIds: ["R1"], verification: "Read search.js" }] }],
});
const completion = { summary: "Commit adds search", tasks: [{ taskId: "T1", evidence: "search.js in the commit" }],
  checks: [{ description: "Tests", outcome: "not_run" as const, evidence: "Not run by the coordinator" }], findings: [] };

test("a Git commit, range or branch comparison resolves to exact commits; names that are not revisions are refused", (t) => {
  const { root, first, search, paging } = repository(t);
  assert.deepEqual(resolveRevision(root, search.slice(0, 8), "git"), { vcs: "git", range: search.slice(0, 8), from: first, to: search, label: `commit ${search.slice(0, 10)}` });
  assert.deepEqual(resolveRevision(root, "HEAD", "git"), { vcs: "git", range: "HEAD", from: search, to: paging, label: `commit ${paging.slice(0, 10)} (HEAD)` });
  const range = resolveRevision(root, "main..feature/search", "git");
  assert.deepEqual([range.from, range.to, range.label], [first, paging, `${first.slice(0, 10)}..${paging.slice(0, 10)} (main..feature/search)`]);
  assert.equal(resolveRevision(root, "main...feature/search", "git").from, first, "a...b starts where b branched off");
  assert.equal(resolveRevision(root, first, "git").from, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "a root commit is compared with the empty tree");
  for (const bad of ["--output=/tmp/x", "-p", "a b", "$(whoami)", "HEAD;ls", "..", "a..b..c"])
    assert.throws(() => resolveRevision(root, bad, "git"), /Not a Git revision|Git has no commit/, bad);
  assert.throws(() => resolveRevision(root, "nope123", "git"), /Git has no commit "nope123" here/);
  assert.throws(() => resolveRevision(root, "main..main", "git"), /contains no changes/);
  assert.throws(() => resolveRevision(root, "HEAD", "none"), /not under Git or SVN/);
});

test("SVN revisions name the changes made in them", () => {
  assert.deepEqual(resolveRevision("/repo", "r1234", "svn"), { vcs: "svn", range: "r1234", from: "1233", to: "1234", label: "r1234" });
  assert.deepEqual(resolveRevision("/repo", "1234:1250", "svn"), { vcs: "svn", range: "1234:1250", from: "1233", to: "1250", label: "r1234:r1250" });
  assert.throws(() => resolveRevision("/repo", "r1250:r1234", "svn"), /from an earlier revision to a later one/);
  assert.throws(() => resolveRevision("/repo", "r0", "svn"), /starting at r1/);
  assert.throws(() => resolveRevision("/repo", "HEAD", "svn"), /SVN revisions look like r1234/);
});

test("an SVN revision range gives the patch, changed files and log of the revisions in it", (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const svn = (cwd: string, ...args: string[]) => execFileSync(args[0] === "create" ? "svnadmin" : "svn", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const repository = join(base, "repository"), root = join(base, "wc");
  svn(base, "create", repository);
  svn(base, "checkout", pathToFileURL(repository).href, root);
  writeFileSync(join(root, "app.txt"), "one\n");
  svn(root, "add", "app.txt");
  svn(root, "commit", "-m", "Start the app"); // r1
  writeFileSync(join(root, "search.txt"), "search\n");
  svn(root, "add", "search.txt");
  svn(root, "commit", "-m", "Add search"); // r2
  writeFileSync(join(root, "app.txt"), "two\n");
  svn(root, "commit", "-m", "Change the app"); // r3
  svn(root, "update");
  const range = resolveRevision(root, "r2:r3", "svn");
  const changes = revisionChanges(root, range);
  assert.deepEqual(changes.changedPaths, ["app.txt", "search.txt"]);
  assert.match(changes.patch, /\+search/);
  assert.match(changes.patch, /-one\n\+two/);
  assert.match(changes.commits, /Add search/);
  assert.match(changes.commits, /Change the app/);
  assert.doesNotMatch(changes.commits, /Start the app/, "only the revisions in the range");
  assert.deepEqual(revisionChanges(root, resolveRevision(root, "r2", "svn")).changedPaths, ["search.txt"]);
});

test("the change's patch, files and commit messages are read, only for this project's folder, and cut when huge", (t) => {
  const { root, first, paging } = repository(t);
  const changes = revisionChanges(root, resolveRevision(root, "main..feature/search", "git"));
  assert.deepEqual(changes.changedPaths, ["app.js", "search.js"]);
  assert.match(changes.patch, /\+export function search\(q\)/);
  assert.match(changes.commits, /\tAdd search\n/);
  assert.match(changes.commits, /\tAdd paging/);
  assert.equal(changes.truncated, false);

  // A sub-project of a monorepo sees only its own files, with its own paths.
  mkdirSync(join(root, "services", "orders"), { recursive: true });
  writeFileSync(join(root, "services", "orders", "orders.js"), "x\n".repeat(maxPatchChars / 2 + 10));
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Add orders");
  const orders = join(root, "services", "orders");
  initProject(orders, initialize);
  const sub = revisionChanges(orders, resolveRevision(orders, "HEAD", "git"));
  assert.deepEqual(sub.changedPaths, ["orders.js"]);
  assert.equal(sub.truncated, true);
  assert.ok(sub.patch.length < maxPatchChars + 300);
  assert.match(sub.patch, /\[WAICC: patch cut at 400000 characters/);
  assert.throws(() => revisionChanges(orders, resolveRevision(orders, `${first}..${paging}`, "git")), /changes no files in this project/);
});

test("--rev review: the session carries the change, and every code review hands the reviewer its patch", (t) => {
  const { root, search } = repository(t);
  assert.throws(() => createRevisionReview(root, "nope123", ""), /Git has no commit/);
  assert.equal(existsSync(join(root, ".pi", "pi-waicc", "sessions")) && readdirSync(join(root, ".pi", "pi-waicc", "sessions")).length, false, "a bad range makes no session");

  const s = createRevisionReview(root, search, "Check the query handling");
  assert.equal(s.requirements[0], `Review the code change commit ${search.slice(0, 10)}: Check the query handling`);
  assert.deepEqual(s.revisionReview!.to, search);
  const reviewed = prepare(root, s.id, contract(s.requirements[0]), "review", "Review it", 0, { kind: "code", completion });
  const round = reviewed.rounds.at(-1)!;
  assert.equal(round.review?.kind, "code");
  const data = round.review!.kind === "code" ? round.review! : null;
  assert.deepEqual(data!.revision!.changedPaths, ["search.js"]);
  assert.equal(data!.revision!.label, `commit ${search.slice(0, 10)}`);
  const dir = roundDirectory(round);
  assert.match(artifact(root, reviewed, `${dir}/changes.patch`), /\+export function search/);
  assert.match(artifact(root, reviewed, `${dir}/commits.txt`), /Add search/);
  const handoff = artifact(root, reviewed, `${dir}/HANDOFF.md`);
  assert.match(handoff, /## The change under review: commit /);
  assert.match(handoff, /changes\.patch/);
  assert.match(handoff, new RegExp(`The checkout is at [0-9a-f]+, not at ${search}`), "the reviewer is told the checkout has moved on");
  const bundle = exportHandoff(root, s.id);
  assert.match(readFileSync(join(bundle, "changes.patch"), "utf8"), /\+export function search/, "an exported handoff carries the patch");
  assert.match(readFileSync(join(bundle, "HANDOFF.md"), "utf8"), /changes\.patch beside this file/);
  assert.equal(loadSession(root, s.id).revisionReview!.range, search);

  // The reviewer finds a problem; after the fix, the re-review still carries the change, plus the fix.
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "needs_changes", summary: "Empty queries crash", questions: [],
    findings: [{ id: "F1", severity: "medium", description: "search(undefined) throws", evidence: "search.js:1" }],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "search.js" }],
    checks: [{ description: "Read the patch", outcome: "passed", evidence: "changes.patch" }],
  });
  const received = ingest(root, s.id);
  assess(root, s.id, { requestId: round.id, decision: "needs_changes", rationale: "Valid", dispositions: [] });
  writeFileSync(join(root, "search.js"), "export function search(q = \"\") { return q.trim(); }\n");
  const again = issue(root, s.id, "review", "Re-review after the fix", undefined, undefined, { kind: "code", completion: {
    ...completion, findings: [{ requestId: received.rounds.at(-1)!.id, findingId: "F1", disposition: "resolved", evidence: "search.js defaults q" }],
  } });
  const second = again.rounds.at(-1)!;
  assert.notEqual(second.id, round.id);
  assert.match(artifact(root, again, `${roundDirectory(second)}/changes.patch`), /\+export function search/);
  assert.ok(second.review?.kind === "code" && second.review.changedPaths.includes("search.js") && second.review.revision!.to === search);
});

test("/waicc-review --rev starts its own session and asks the main agent to scope the review; a bad range starts nothing", async (t) => {
  const { root } = repository(t);
  const commands = new Map<string, any>(), sent: string[] = [], notices: string[] = [];
  waicc({
    registerCommand: (name: string, c: any) => commands.set(name, c), registerTool() {}, on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {},
    sendUserMessage: (m: string) => sent.push(m),
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "rev-chat", getBranch: () => [] }, ui: { notify: (m: string) => notices.push(m) },
  } as unknown as ExtensionCommandContext;
  const review = commands.get("waicc-review");
  await review.handler("--rev", ctx).catch((e: Error) => notices.push(e.message));
  await review.handler("--rev nope123 Check it", ctx).catch((e: Error) => notices.push(e.message));
  assert.ok(notices.some((n) => /Usage: \/waicc-review --rev/.test(n)));
  assert.ok(notices.some((n) => /Git has no commit "nope123"/.test(n)));
  assert.equal(sent.length, 0);
  await review.handler("--rev main..feature/search Check paging", ctx);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /reviews an existing Git change: .*\(main\.\.feature\/search\)/);
  assert.match(sent[0], /waicc_prepare mode review with reviewKind code/);
  assert.match(sent[0], /Do not edit code/);
});

/**
 * A GitLab stand-in: a bare repository where merge request 7 is published as
 * refs/merge-requests/7/head, as GitLab does, and a reviewer's fresh clone of it. The
 * merge request touches two services of a monorepo.
 */
function gitlab(t: TestContext) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  const server = join(base, "server.git"), author = join(base, "author"), reviewer = join(base, "reviewer");
  git(base, "init", "-q", "--bare", "-b", "develop", server);
  git(base, "clone", "-q", server, author);
  git(author, "switch", "-q", "-c", "develop");
  for (const service of ["orders", "status"]) {
    mkdirSync(join(author, "services", service), { recursive: true });
    writeFileSync(join(author, "services", service, "app.js"), `export const ${service} = 1;\n`);
  }
  git(author, "add", ".");
  git(author, "commit", "-q", "-m", "Two services");
  git(author, "push", "-q", "origin", "develop");
  git(author, "switch", "-q", "-c", "feature/sync");
  writeFileSync(join(author, "services", "orders", "app.js"), `export const orders = 2;\n${"// order line\n".repeat(9000)}`);
  writeFileSync(join(author, "services", "status", "app.js"), "export const status = 2;\n");
  git(author, "commit", "-q", "-am", "Sync orders and status");
  git(author, "push", "-q", "origin", "HEAD:refs/merge-requests/7/head");
  git(base, "clone", "-q", server, reviewer);
  return { base, server, author, reviewer };
}

test("--mr fetches a GitLab merge request with plain git into WAICC's own refs, diffed against its target", async (t) => {
  const { author, reviewer } = gitlab(t);
  const branches = git(reviewer, "branch", "--all");
  const mr = await fetchMergeRequest(reviewer, "!7");
  assert.equal(mr.range, "!7");
  assert.deepEqual({ ...mr.mergeRequest, url: null }, { remote: "origin", number: 7, provider: "gitlab", target: "develop", url: null, head: git(author, "rev-parse", "HEAD") });
  assert.equal(mr.from, git(author, "rev-parse", "develop"));
  assert.match(mr.label, /^merge request !7 into develop \(/);
  assert.equal(git(reviewer, "rev-parse", "refs/waicc/mr/7/head"), mr.to);
  assert.equal(git(reviewer, "branch", "--all"), branches, "no branch of yours is created or moved");
  assert.equal(git(reviewer, "status", "--porcelain"), "", "the working folder is untouched");

  // Large and across two services of the monorepo: one patch per service as well.
  const changes = revisionChanges(reviewer, mr);
  assert.deepEqual(changes.changedPaths, ["services/orders/app.js", "services/status/app.js"]);
  assert.deepEqual(changes.parts.map((p) => [p.folder, p.file, p.paths]), [["services/orders", "services_orders.patch", 1], ["services/status", "services_status.patch", 1]]);
  assert.match(changes.parts[1].patch, /\+export const status = 2;/);
  assert.doesNotMatch(changes.parts[1].patch, /orders/);

  assert.equal((await fetchMergeRequest(reviewer, "7", { into: "develop" })).to, mr.to);
  await assert.rejects(fetchMergeRequest(reviewer, "!8"), /origin has no merge request !8 \(refs\/merge-requests\/8\/head\) or no branch develop/);
  await assert.rejects(fetchMergeRequest(reviewer, "!7", { into: "nope" }), /or no branch nope/);
  await assert.rejects(fetchMergeRequest(reviewer, "seven"), /A merge request is its number/);
  await assert.rejects(fetchMergeRequest(reviewer, "!7", { into: "--upload-pack=x" }), /Not a branch name/);
  git(reviewer, "remote", "add", "mirror", "https://example.invalid/x.git");
  git(reviewer, "remote", "rename", "origin", "upstream");
  await assert.rejects(fetchMergeRequest(reviewer, "!7"), /several remotes; pick one with --remote <name>: mirror, upstream/);
  assert.equal((await fetchMergeRequest(reviewer, "!7", { remote: "upstream" })).mergeRequest!.remote, "upstream");
  assert.equal(safeRemoteUrl("https://whatley:glpat-secret@gitlab.example.com/a/b.git"), "https://gitlab.example.com/a/b.git", "a password in the remote URL is never recorded");
});

test("/waicc-review --mr --list: pick a merge request and its review starts; with a GitLab token, open ones with titles", async (t) => {
  const { reviewer, author } = gitlab(t);
  // An older merge request, !3, with its own change.
  git(author, "switch", "-q", "-c", "fix/readme", "develop");
  writeFileSync(join(author, "README.md"), "fixed\n");
  git(author, "add", ".");
  git(author, "commit", "-q", "-m", "Fix the readme");
  git(author, "push", "-q", "origin", "HEAD:refs/merge-requests/3/head");
  const commands = new Map<string, any>(), sent: string[] = [], shown: string[] = [];
  let offered: { title: string; options: string[] } | undefined;
  const agentDir = join(reviewer, "..", "agent");
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { process.env.PI_CODING_AGENT_DIR = previous; });
  const api: string[] = [];
  waicc({
    registerCommand: (name: string, c: any) => commands.set(name, c), registerTool() {}, on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
    sendMessage: (m: { content: string }) => shown.push(m.content), sendUserMessage: (m: string) => sent.push(m),
  } as unknown as ExtensionAPI, { gitlab: () => async (_method, path) => (api.push(path), [
    { iid: 7, title: "Sync orders and status", author: { username: "lifeng" }, source_branch: "feature/sync", target_branch: "develop", updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), draft: false },
    { iid: 9, title: "WIP export", author: { username: "ali" }, source_branch: "export", target_branch: "develop", updated_at: new Date().toISOString(), draft: true },
  ]) });
  const ctx = (hasUI: boolean) => ({
    cwd: reviewer, mode: "tui", hasUI, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "list-chat", getBranch: () => [] },
    ui: { notify() {}, select: async (title: string, options: string[]) => ((offered = { title, options }), options[0]) },
  }) as unknown as ExtensionCommandContext;

  // Without a token: plain git lists the numbers, newest first; picking one starts its review.
  await commands.get("waicc-review").handler("--mr --list", ctx(true));
  assert.match(offered!.title, /^The newest 2 merge request numbers on origin\. Without a GitLab token git cannot tell open from merged ones/);
  assert.deepEqual(offered!.options.map((o) => o.split(" · ")[0]), ["!7", "!3", "Cancel"]);
  assert.match(sent[0], /This new session reviews merge request !7 into develop/, "the picked one is reviewed");

  // With the host's token: GitLab's open merge requests, and the one already in review is marked.
  git(reviewer, "remote", "set-url", "origin", "https://gitlab.example.com/team/app.git");
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ gitlab: { "gitlab.example.com": { token: "glpat-secret-1" } } }));
  await commands.get("waicc-review").handler("--mr list", ctx(false));
  assert.equal(api[0], "/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=50");
  assert.match(shown.at(-1)!, /^2 open merge requests on team\/app: pick one to review\n- !7 Sync orders and status · lifeng · feature\/sync → develop · 2h ago · in review: draft\n- !9 \[draft\] WIP export · ali · export → develop · 0m ago$/,
    "!7 is already in review here");
});

test("/waicc-review --mr starts a review session for the MR, and fetching it again picks up the author's new commits", async (t) => {
  const { author, reviewer } = gitlab(t);
  const commands = new Map<string, any>(), sent: string[] = [];
  waicc({
    registerCommand: (name: string, c: any) => commands.set(name, c), registerTool() {}, on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage: (m: string) => sent.push(m),
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: reviewer, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "mr-chat", getBranch: () => [] }, ui: { notify() {} },
  } as unknown as ExtensionCommandContext;
  await commands.get("waicc-review").handler("--mr !7 Check the sync", ctx);
  assert.match(sent[0], /This new session reviews merge request !7 into develop, fetched by WAICC from origin/);
  assert.match(sent[0], /one task per service or area it touches/);
  const sessions = readdirSync(join(reviewer, ".pi", "pi-waicc", "sessions"));
  assert.equal(sessions.length, 1, "no init needed: the repository root is the project");
  const s = loadSession(reviewer, sessions[0]);
  assert.equal(s.revisionReview!.mergeRequest!.number, 7);
  assert.match(s.requirements[0], /^Review the code change merge request !7 into develop .*: Check the sync$/);

  // The author pushes a fix; the same command in the same chat fetches it into the same session.
  writeFileSync(join(author, "services", "status", "app.js"), "export const status = 3;\n");
  git(author, "commit", "-q", "-am", "Fix status");
  git(author, "push", "-q", "-f", "origin", "HEAD:refs/merge-requests/7/head");
  await commands.get("waicc-review").handler("--mr 7", ctx);
  assert.equal(readdirSync(join(reviewer, ".pi", "pi-waicc", "sessions")).length, 1);
  assert.equal(loadSession(reviewer, s.id).revisionReview!.to, git(author, "rev-parse", "HEAD"));
  assert.match(sent[1], /Merge request !7 was fetched again: its head is [0-9a-f]+ \(was [0-9a-f]+\)/);
});
