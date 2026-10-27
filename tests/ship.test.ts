import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { artifact, json, loadSession, sessionRelative } from "../src/files.ts";
import { roundDirectory } from "../src/render.ts";
import { parseDispatchArgs } from "../src/dispatch.ts";
import { planShip, requestOpener, ship } from "../src/ship.ts";
import { assess, closeShipped, createSession, ingest, issue, prepare } from "../src/workflow.ts";
import type { Contract, Reply, Session, WorkCompletion } from "../src/types.ts";

const scope: Contract = {
  title: "Search with paging",
  requirements: [{ id: "R1", text: "Search pages its results", sourceQuote: "Add search with paging" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: ["API", "CLIENT"].map((id, i) => ({
    id, title: `${id} search`, requirementIds: ["R1"], dependsOn: i ? ["API"] : [], allowedPaths: [`${id}.txt`],
    acceptance: [{ id: `AC${i}`, text: "Results are paged", requirementIds: ["R1"], verification: "Run the search tests" }],
  })),
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Like GitLab: push options that ask for a merge request are answered with its address.
const hook = [
  "#!/bin/sh",
  "i=0",
  'while [ "$i" -lt "${GIT_PUSH_OPTION_COUNT:-0}" ]; do eval "echo \\"option: \\$GIT_PUSH_OPTION_$i\\""; i=$((i+1)); done',
  'if [ "${GIT_PUSH_OPTION_COUNT:-0}" -gt 0 ]; then echo "View merge request for the change:"; echo "  https://gitlab.example.com/team/app/-/merge_requests/7"; fi',
  "",
].join("\n");

function reply(root: string, s: Session, updates: Partial<Reply> = {}) {
  const r = s.rounds.at(-1)!;
  writeFileSync(join(root, sessionRelative(s.id), roundDirectory(r), "reply.json"), json({
    ...JSON.parse(artifact(root, s, `${roundDirectory(r)}/reply.example.json`)),
    outcome: "ready", summary: "Inspected the whole change", findings: [], questions: [],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "API.txt and CLIENT.txt page results" }],
    checks: [{ description: "Read API and CLIENT", outcome: "passed", evidence: "Source inspected" }],
    ...updates,
  }));
  return ingest(root, s.id);
}
const decide = (root: string, s: Session, decision: "planned" | "ready") =>
  assess(root, s.id, { requestId: s.rounds.at(-1)!.id, decision, rationale: "Checked source and evidence", dispositions: [] });
const completion = (): WorkCompletion => ({
  summary: "Search pages its results in the API and the client.",
  tasks: scope.tasks.map((task) => ({ taskId: task.id, evidence: `${task.id}.txt pages results` })),
  checks: [{ description: "npm test", outcome: "passed", evidence: "12 passing" }], findings: [],
});

/** A Git project whose origin is a GitLab address (pushes go to a local bare repository), with a reviewed change READY_TO_CLOSE. */
function reviewed(t: TestContext, url = "https://gitlab.example.com/team/app.git") {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-ship-")));
  t.after(() => {
    assert.ok(basename(base).startsWith("waicc-ship-"));
    rmSync(base, { recursive: true, force: true });
  });
  const bare = join(base, "remote.git"), root = join(base, "app");
  mkdirSync(root);
  git(base, "init", "--quiet", "--bare", bare);
  git(bare, "config", "receive.advertisePushOptions", "true");
  git(bare, "config", "core.hooksPath", join(bare, "hooks"));
  writeFileSync(join(bare, "hooks", "pre-receive"), hook);
  chmodSync(join(bare, "hooks", "pre-receive"), 0o755);
  git(root, "init", "--quiet", "-b", "main");
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.com"], ["commit.gpgsign", "false"], ["core.hooksPath", join(root, "no-hooks")]]) git(root, "config", key, value);
  writeFileSync(join(root, "API.txt"), "api");
  writeFileSync(join(root, "CLIENT.txt"), "client");
  writeFileSync(join(root, "notes.txt"), "notes");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "Start");
  git(root, "remote", "add", "origin", url);
  git(root, "remote", "set-url", "--push", "origin", bare);
  git(root, "push", "--quiet", "origin", "main");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  // Your own unfinished edit from before the session: never part of what is shipped.
  writeFileSync(join(root, "notes.txt"), "my own notes");
  let s = createSession(root, "Add search with paging");
  s = decide(root, reply(root, prepare(root, s.id, scope, "planning", "Plan search", 0), { outcome: "planned" }), "planned");
  writeFileSync(join(root, "API.txt"), "api with paging");
  writeFileSync(join(root, "CLIENT.txt"), "client with paging");
  s = issue(root, s.id, "review", "Review the whole change", undefined, undefined, { kind: "code", completion: completion() });
  s = decide(root, reply(root, s), "ready");
  assert.equal(s.status, "READY_TO_CLOSE");
  return { root, bare, id: s.id };
}
const changedIn = (bare: string, branch: string) => git(bare, "show", "--name-only", "--format=%s", branch).split(/\r?\n/).filter(Boolean);

test("shipping commits only the reviewed files on a new branch, pushes, opens the merge request with GitLab's API and closes", async (t) => {
  const { root, bare, id } = reviewed(t);
  const plan = planShip(root, id);
  assert.equal(plan.branch, "waicc/search-with-paging");
  assert.equal(plan.target, "main");
  assert.deepEqual(plan.files, ["API.txt", "CLIENT.txt"]);
  assert.deepEqual(plan.leftOut, ["notes.txt"]);
  assert.match(plan.description, /Planned, coded and reviewed by AI agents in WAICC[\s\S]*\*\*R1:\*\* Search pages its results[\s\S]*✅ npm test[\s\S]*Independent AI code review passed/);
  const calls: { method: string; path: string; body?: any }[] = [];
  const opener = await requestOpener(plan, {
    host: (name) => (name === "gitlab.example.com" ? { token: "glpat-test", allowHttp: false } : null),
    origin: async (project) => project,
    gitlab: () => async (method, path, body) => {
      calls.push({ method, path, body });
      return method === "GET" ? [] : { iid: 12, web_url: "https://gitlab.example.com/team/app/-/merge_requests/12" };
    },
  });
  assert.equal(opener.pushOptions, undefined, "with a token the API opens it, not the push");
  const shipped = await ship(plan, opener);
  assert.deepEqual(shipped.request, { number: 12, url: "https://gitlab.example.com/team/app/-/merge_requests/12", how: "api", note: null });
  assert.equal(calls[0].method, "GET");
  assert.deepEqual({ ...calls[1].body, description: undefined }, { source_branch: "waicc/search-with-paging", target_branch: "main", title: "Search with paging", description: undefined, remove_source_branch: true });
  assert.equal(calls[1].body.description, plan.description);
  assert.deepEqual(changedIn(bare, "waicc/search-with-paging"), ["Search with paging", "API.txt", "CLIENT.txt"]);
  assert.equal(git(root, "branch", "--show-current"), "waicc/search-with-paging");
  assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "my own notes");
  assert.equal(git(root, "status", "--porcelain"), "M notes.txt", "your own edit stays uncommitted");
  const closed = closeShipped(root, id, shipped);
  assert.equal(closed.status, "CLOSED");
  assert.match(closed.closure!.reason, /^Shipped as https:\/\/gitlab\.example\.com\/team\/app\/-\/merge_requests\/12/);
  assert.equal(loadSession(root, id).shipped!.commit, git(root, "rev-parse", "HEAD"));
});

test("without a GitLab token, the push itself opens the merge request (push options)", async (t) => {
  const { root, bare, id } = reviewed(t);
  const plan = planShip(root, id, { branch: "feature/paging", draft: true });
  const opener = await requestOpener(plan, { host: () => null, origin: async (project) => project });
  assert.ok(opener.pushOptions!.includes("merge_request.create"));
  assert.ok(opener.pushOptions!.includes("merge_request.title=Draft: Search with paging"));
  const shipped = await ship(plan, opener);
  assert.equal(shipped.request.how, "push-options");
  assert.equal(shipped.request.url, "https://gitlab.example.com/team/app/-/merge_requests/7");
  assert.match(shipped.request.note!, /Opened without a GitLab token/);
  assert.deepEqual(changedIn(bare, "feature/paging").slice(1), ["API.txt", "CLIENT.txt"]);
});

test("GitHub opens a pull request through gh; refusals come before anything changes", async (t) => {
  const { root, id } = reviewed(t, "https://github.com/team/app.git");
  // Straight onto the target, or onto a branch you already have, is refused.
  assert.throws(() => planShip(root, id, { branch: "main" }), /would go straight onto main/);
  git(root, "branch", "taken", "main");
  assert.throws(() => planShip(root, id, { branch: "taken" }), /Branch taken already exists/);
  const plan = planShip(root, id);
  assert.equal(plan.provider, "github");
  let asked: string | null = null;
  const opener = await requestOpener(plan, { host: () => null, github: async (p) => ((asked = p.branch), { number: 3, url: "https://github.com/team/app/pull/3", how: "gh", note: null }) });
  assert.equal(opener.pushOptions, undefined);
  const shipped = await ship(plan, opener);
  assert.equal(asked, "waicc/search-with-paging");
  assert.equal(shipped.request.url, "https://github.com/team/app/pull/3");
  closeShipped(root, id, shipped);
  assert.throws(() => planShip(root, id), /Only a change whose whole-change code review passed can be shipped/);
});

test("a reviewed file changed after the review, or after you confirmed, cannot ship", async (t) => {
  const { root, id } = reviewed(t);
  const plan = planShip(root, id);
  writeFileSync(join(root, "API.txt"), "changed after the review");
  assert.throws(() => planShip(root, id), /files changed since the passing review/);
  await assert.rejects(ship(plan, { open: async () => ({ number: null, url: null, how: "none", note: null }) }), /Files changed after the plan was made, so nothing was committed/);
  assert.equal(git(root, "branch", "--show-current"), "main");
});

test("/waicc-ship asks first, and --ship is only for runs that end in a code review", async (t) => {
  const { root, bare, id } = reviewed(t);
  const commands = new Map<string, any>(), confirms: string[] = [], notices: string[] = [];
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "..", "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR);
  t.after(() => { process.env.PI_CODING_AGENT_DIR = previous; });
  let answer = false;
  waicc({
    registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {}, on() {},
    appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI, { gitlabOrigin: async (project) => project });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "chat", getBranch: () => [], getEntries: () => [] },
    ui: { notify: (m: string) => notices.push(m), setStatus() {}, setWidget() {}, confirm: async (title: string, body: string) => (confirms.push(`${title}\n${body}`), answer) },
  };
  await commands.get("waicc-use").handler(id, ctx);
  await commands.get("waicc-ship").handler("--branch feature/paging", ctx);
  assert.match(confirms[0], /^Ship this change\?\nNew branch feature\/paging → merge request into main[\s\S]*Commit 2 reviewed files:\n  API\.txt\n  CLIENT\.txt[\s\S]*Not included[\s\S]*notes\.txt/);
  assert.ok(notices.includes("Nothing was committed or pushed. /waicc-ship when you are ready."));
  assert.equal(git(root, "branch", "--show-current"), "main", "no means nothing happened");
  answer = true;
  await commands.get("waicc-ship").handler("--branch feature/paging", ctx);
  assert.equal(loadSession(root, id).status, "CLOSED");
  assert.ok(notices.some((n) => n.startsWith("Shipped: Opened https://gitlab.example.com/team/app/-/merge_requests/7")));
  assert.deepEqual(changedIn(bare, "feature/paging").slice(1), ["API.txt", "CLIENT.txt"]);

  assert.equal(parseDispatchArgs("--auto --ship").options.ship, true);
  assert.equal(parseDispatchArgs("--loop 3 --ship").options.ship, true);
  assert.throws(() => parseDispatchArgs("--ship"), /--ship ships the change when the run's code review passes/);
  assert.throws(() => parseDispatchArgs("--auto --review-once --ship"), /not --review-once/);
});
