import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { prepareDispatch, runDispatch, type AgentRunner } from "../src/dispatch.ts";
import { initialize, loadSession } from "../src/files.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { initProject, projectRoot, snapshot } from "../src/source.ts";
import { assess, createSession, delegateWork, ingest, prepare } from "../src/workflow.ts";
import { removeIsolation } from "../src/worktree.ts";
import type { Contract } from "../src/types.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", windowsHide: true });

/** Cleanups run in registration order, so the repository may already be gone: then delete the copy directly. */
const cleanup = (worktree: string, remove: () => void) => {
  if (!existsSync(worktree)) return;
  try {
    remove();
  } catch {
    rmSync(worktree, { recursive: true, force: true }); // No dependency links in these fixtures.
  }
};

/** A Git monorepo with two services, everything committed. */
function monorepo(t: TestContext) {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(repo).startsWith("waicc-test-"));
    rmSync(repo, { recursive: true, force: true });
  });
  const status = join(repo, "services", "status"), orders = join(repo, "services", "orders");
  mkdirSync(join(status, "src"), { recursive: true });
  mkdirSync(orders, { recursive: true });
  writeFileSync(join(repo, "README.md"), "monorepo\n");
  writeFileSync(join(status, "app.txt"), "status app\n");
  writeFileSync(join(status, "src", "x.txt"), "status source\n");
  writeFileSync(join(orders, "o.txt"), "orders\n");
  git(repo, "init", "--quiet");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "base");
  return { repo, status, orders };
}

test("/waicc-init makes one service its own project, fingerprinted as its own Git subtree", (t) => {
  const { repo, status, orders } = monorepo(t);
  assert.equal(projectRoot(join(status, "src")), repo, "before init, the repository root");
  const made = initProject(status, initialize);
  assert.equal(made.created, true);
  assert.equal(made.previousProjectRoot, repo);
  assert.equal(made.repositoryPath, "services/status/");
  assert.equal(made.sourceFiles, 2);
  assert.equal(initProject(status, initialize).created, false, "running it again changes nothing");
  assert.equal(projectRoot(join(status, "src")), status);
  assert.equal(projectRoot(orders), repo, "other services are unaffected");

  const before = snapshot(status);
  assert.equal(before.vcs, "git");
  assert.deepEqual(Object.keys(before.files).sort(), ["app.txt", "src/x.txt"]);
  // Another team's commit elsewhere in the monorepo does not count as a change here.
  writeFileSync(join(orders, "o.txt"), "orders changed\n");
  git(repo, "commit", "--quiet", "-am", "orders work");
  assert.equal(snapshot(status).fingerprint, before.fingerprint);
  writeFileSync(join(status, "app.txt"), "status changed\n");
  assert.notEqual(snapshot(status).fingerprint, before.fingerprint);
  // WAICC's state folder ignores itself, so the monorepo shows nothing new.
  assert.equal(git(repo, "status", "--porcelain", "--", "services/status/.pi"), "");

  const cli = spawnSync(process.execPath, [resolve("src/cli.ts"), "init"], { cwd: orders, encoding: "utf8", windowsHide: true });
  assert.equal(JSON.parse(cli.stdout).projectRoot, realpathSync.native(orders));
});

test("Claude or Codex coding in a sub-project gets the whole monorepo as context, and only the sub-project's changes apply", async (t) => {
  const { repo, status } = monorepo(t);
  initProject(status, initialize);
  const contract: Contract = {
    title: "Status", requirements: [{ id: "R1", text: "Change the status app", sourceQuote: "Change the status app" }],
    exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
    tasks: [{ id: "T1", title: "App", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"],
      acceptance: [{ id: "AC1", text: "App changed", requirementIds: ["R1"], verification: "Read app.txt" }] }],
  };
  const body = (outcome: string) => ({ outcome, summary: "Done", findings: [], questions: [],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
    checks: [{ description: "Read", outcome: "passed", evidence: "Inspected" }] });
  const waiting = () => {
    const s = createSession(status, "Change the status app");
    prepare(status, s.id, contract, "planning", "Plan", 0);
    submitRecipientReply(status, receiveHandoff(status, s.id).pin, body("planned"));
    const received = ingest(status, s.id);
    assess(status, s.id, { requestId: received.rounds.at(-1)!.id, decision: "planned", rationale: "Checked", dispositions: [] });
    delegateWork(status, s.id, "implementation", "Implement");
    return s.id;
  };
  const agent = (id: string, edit: (cwd: string) => void): AgentRunner => async (_program, _args, options) => {
    const { pin } = receiveHandoff(status, id, true);
    edit(options.cwd);
    submitRecipientReply(status, pin, { ...body("ready"), completion: { summary: "Done", tasks: [{ taskId: "T1", evidence: "app.txt" }], checks: body("ready").checks, findings: [] } });
    return { stdout: "", stderr: "", code: 0, killed: false };
  };

  const inScope = waiting();
  const plan = prepareDispatch(status, inScope, { via: "codex", implement: true });
  t.after(() => cleanup(plan.isolation!.worktree, () => removeIsolation(status, plan.isolation!)));
  assert.equal(plan.cwd, join(plan.isolation!.worktree, "services", "status"));
  // Context is checked out normally (line endings may follow core.autocrlf); it is never applied back.
  assert.match(readFileSync(join(plan.isolation!.worktree, "services", "orders", "o.txt"), "utf8"), /^orders\r?\n$/, "the rest of the monorepo is there as context");
  assert.equal(readFileSync(join(plan.cwd, "app.txt"), "utf8"), "status app\n", "the project's own files are exact copies");
  assert.match(plan.prompt, /one folder of a larger repository/);
  const done = await runDispatch(plan, agent(inScope, (cwd) => writeFileSync(join(cwd, "app.txt"), "status app, changed\n")));
  assert.equal(done.isolation?.applied, true, done.isolation?.reason ?? "");
  assert.deepEqual(done.isolation?.changes, [{ status: "M", path: "app.txt" }]);
  assert.equal(readFileSync(join(status, "app.txt"), "utf8"), "status app, changed\n");

  // A change to another service in the copy is outside the project: nothing is applied.
  ingest(status, inScope);
  const outside = waiting();
  const plan2 = prepareDispatch(status, outside, { via: "claude", implement: true });
  t.after(() => cleanup(plan2.isolation!.worktree, () => removeIsolation(status, plan2.isolation!)));
  const refused = await runDispatch(plan2, agent(outside, (cwd) => {
    writeFileSync(join(cwd, "app.txt"), "again\n");
    writeFileSync(join(cwd, "..", "orders", "o.txt"), "edited by the status agent\n");
  }));
  assert.equal(refused.isolation?.applied, false);
  assert.match(refused.isolation!.reason!, /\.\.\/orders\/o\.txt is outside the task's allowed paths/);
  assert.equal(readFileSync(join(repo, "services", "orders", "o.txt"), "utf8"), "orders\n");
  assert.equal(loadSession(status, outside).projectRoot, status);
});

test("an over-sized project points to /waicc-init", (t) => {
  const big = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => rmSync(big, { recursive: true, force: true }));
  for (let i = 0; i <= 10_000; i++) writeFileSync(join(big, `f${i}.txt`), "");
  assert.throws(() => snapshot(big), /Source exceeds 10,000 files\. In a monorepo, run \/waicc-init \(CLI: waicc init\) inside the service folder/);
});
