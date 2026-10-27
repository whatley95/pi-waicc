import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { artifact, json, sessionRelative } from "../src/files.ts";
import { roundDirectory } from "../src/render.ts";
import { assess, createSession, ingest, issue, prepare } from "../src/workflow.ts";
import type { Contract, IssueLink, Reply, Session, WorkCompletion } from "../src/types.ts";

/** A reviewed change ready to ship, in a real Git repository with a local bare remote (tests/ship.test.ts, tests/ci.test.ts). */
export const scope: Contract = {
  title: "Search with paging",
  requirements: [{ id: "R1", text: "Search pages its results", sourceQuote: "Add search with paging" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: ["API", "CLIENT"].map((id, i) => ({
    id, title: `${id} search`, requirementIds: ["R1"], dependsOn: i ? ["API"] : [], allowedPaths: [`${id}.txt`],
    acceptance: [{ id: `AC${i}`, text: "Results are paged", requirementIds: ["R1"], verification: "Run the search tests" }],
  })),
};
export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Like GitLab: push options that ask for a merge request are answered with its address.
const hook = [
  "#!/bin/sh",
  "i=0",
  'while [ "$i" -lt "${GIT_PUSH_OPTION_COUNT:-0}" ]; do eval "echo \\"option: \\$GIT_PUSH_OPTION_$i\\""; i=$((i+1)); done',
  'if [ "${GIT_PUSH_OPTION_COUNT:-0}" -gt 0 ]; then echo "View merge request for the change:"; echo "  https://gitlab.example.com/team/app/-/merge_requests/7"; fi',
  "",
].join("\n");

export function reply(root: string, s: Session, updates: Partial<Reply> = {}) {
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
export const decide = (root: string, s: Session, decision: "planned" | "ready") =>
  assess(root, s.id, { requestId: s.rounds.at(-1)!.id, decision, rationale: "Checked source and evidence", dispositions: [] });
export const completion = (): WorkCompletion => ({
  summary: "Search pages its results in the API and the client.",
  tasks: scope.tasks.map((task) => ({ taskId: task.id, evidence: `${task.id}.txt pages results` })),
  checks: [{ description: "npm test", outcome: "passed", evidence: "12 passing" }], findings: [],
});

/** A Git project whose origin is a GitLab address (pushes go to a local bare repository), with a reviewed change READY_TO_CLOSE. */
export function reviewed(t: TestContext, url = "https://gitlab.example.com/team/app.git", issueLink?: IssueLink) {
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
  let s = createSession(root, "Add search with paging", undefined, undefined, issueLink);
  s = decide(root, reply(root, prepare(root, s.id, scope, "planning", "Plan search", 0), { outcome: "planned" }), "planned");
  writeFileSync(join(root, "API.txt"), "api with paging");
  writeFileSync(join(root, "CLIENT.txt"), "client with paging");
  s = issue(root, s.id, "review", "Review the whole change", undefined, undefined, { kind: "code", completion: completion() });
  s = decide(root, reply(root, s), "ready");
  assert.equal(s.status, "READY_TO_CLOSE");
  return { root, bare, id: s.id };
}
export const changedIn = (bare: string, branch: string) => git(bare, "show", "--name-only", "--format=%s", branch).split(/\r?\n/).filter(Boolean);
