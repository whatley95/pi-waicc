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
import { maxPatchChars, resolveRevision, revisionChanges } from "../src/revision.ts";
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
