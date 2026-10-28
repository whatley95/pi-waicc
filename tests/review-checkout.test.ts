import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { prepareDispatch, runDispatch, type AgentRunner } from "../src/dispatch.ts";
import { createRevisionReview, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

/** A repository on its paging commit, and a review of the search commit before it. */
function reviewOf(t: TestContext, which: "search" | "paging") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "app.js"), "export const app = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Start the app");
  writeFileSync(join(root, "search.js"), "export function search(q) { return q.trim(); }\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Add search");
  const search = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "app.js"), "export const app = 2; // paging\n");
  git(root, "commit", "-q", "-am", "Add paging");
  const s = createRevisionReview(root, which === "search" ? search : "HEAD", "");
  const request = s.requirements[0];
  const contract: Contract = {
    title: "Review", requirements: [{ id: "R1", text: request, sourceQuote: request }], exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
    tasks: [{ id: "T1", title: "Review", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["search.js", "app.js"], acceptance: [{ id: "AC1", text: "Read", requirementIds: ["R1"], verification: "Read it" }] }],
  };
  prepare(root, s.id, contract, "review", "Review it", 0, { kind: "code", completion: { summary: "The change", tasks: [{ taskId: "T1", evidence: "the commit" }], checks: [{ description: "Tests", outcome: "not_run", evidence: "None here" }], findings: [] } });
  return { root, id: s.id, search };
}
const worktrees = (root: string) => git(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;

test("a reviewer of an earlier commit reads that commit's own checkout, which goes when the run ends", async (t) => {
  const { root, id, search } = reviewOf(t, "search");
  const plan = prepareDispatch(root, id, { via: "codex" });
  assert.ok(plan.checkout, "the working folder is at a later commit");
  assert.equal(plan.cwd, plan.checkout!.workdir);
  assert.notEqual(plan.cwd, root);
  assert.equal(plan.checkout!.commit, search);
  // Checked out as Git does on this machine, so line endings follow core.autocrlf.
  assert.equal(readFileSync(join(plan.cwd, "app.js"), "utf8").replace(/\r\n/g, "\n"), "export const app = 1;\n", "the files as the reviewed commit has them");
  assert.ok(plan.prompt.includes(`checked out for you, read-only, at ${JSON.stringify(plan.checkout!.workdir)}`));
  assert.ok(plan.args.includes(plan.checkout!.workdir), "codex runs there (-C)");
  let ranIn = "";
  const runner: AgentRunner = async (_program, _args, options) => ((ranIn = options.cwd), { stdout: "", stderr: "", code: 0, killed: false });
  await runDispatch(plan, runner);
  assert.equal(ranIn, plan.checkout!.workdir);
  assert.equal(existsSync(plan.checkout!.workdir), false, "removed after the run");
  assert.equal(worktrees(root), 1);
  assert.equal(readFileSync(join(root, "app.js"), "utf8"), "export const app = 2; // paging\n", "your working folder is untouched");
});

test("Claude may still read the handoff in the project; a Pi reviewer stays in the project and is told where the checkout is", async (t) => {
  const { root, id } = reviewOf(t, "search");
  const claude = prepareDispatch(root, id, { via: "claude" });
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--add-dir"), claude.args.indexOf("--add-dir") + 2), ["--add-dir", root]);
  await runDispatch(claude, async () => ({ stdout: "", stderr: "", code: 0, killed: false }));

  const pi = prepareDispatch(root, id, { via: "pi" });
  assert.equal(pi.cwd, root, "Pi loads WAICC from the folder it runs in");
  assert.ok(pi.args.at(-1)!.includes(`checked out, read-only, at ${JSON.stringify(pi.checkout!.workdir)}`));
  await runDispatch(pi, async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
  assert.equal(worktrees(root), 1);
});

test("a review of the commit the working folder is on reads the working folder", (t) => {
  const { root, id } = reviewOf(t, "paging");
  const plan = prepareDispatch(root, id, { via: "codex" });
  assert.equal(plan.checkout, null);
  assert.equal(plan.cwd, root);
  assert.equal(worktrees(root), 1);
});
