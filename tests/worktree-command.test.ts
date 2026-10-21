import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { addWorktree, removeWorktree, worktrees } from "../src/branches.ts";
import { initialize } from "../src/files.ts";
import { initProject } from "../src/source.ts";
import { createSession } from "../src/workflow.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

/** A monorepo clone with a WAICC service, a local branch, and a branch only on the remote. */
function monorepo(t: TestContext) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    // Worktrees first, so their folders beside the clone go too.
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  const server = join(base, "server.git"), seed = join(base, "seed"), repo = join(base, "mono");
  git(base, "init", "-q", "--bare", "-b", "develop", server);
  git(base, "clone", "-q", server, seed);
  git(seed, "switch", "-q", "-c", "develop");
  mkdirSync(join(seed, "services", "orders"), { recursive: true });
  writeFileSync(join(seed, "services", "orders", "app.js"), "orders\n");
  writeFileSync(join(seed, "README.md"), "mono\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "Monorepo");
  git(seed, "push", "-q", "origin", "develop");
  git(seed, "push", "-q", "origin", "develop:feature/remote-only");
  git(base, "clone", "-q", server, repo);
  git(repo, "branch", "-q", "feature/local");
  const service = join(repo, "services", "orders");
  initProject(service, initialize);
  return { base, repo, service };
}

test("a branch gets its own folder beside the repository: local, tracking the remote's, or new", (t) => {
  const { base, repo, service } = monorepo(t);
  const local = addWorktree(service, "feature/local");
  assert.equal(local.path, join(base, "mono-feature-local"));
  assert.equal(local.kind, "existing");
  assert.equal(git(local.path, "branch", "--show-current"), "feature/local");
  assert.equal(local.startIn, join(local.path, "services", "orders"), "Pi starts in the same service");
  assert.ok(local.initialized && existsSync(join(local.startIn, ".pi", "pi-waicc")), "the service is set up for WAICC there too");

  const tracking = addWorktree(service, "feature/remote-only");
  assert.equal(tracking.kind, "tracking");
  assert.equal(git(tracking.path, "rev-parse", "--abbrev-ref", "@{u}"), "origin/feature/remote-only");

  const fresh = addWorktree(repo, "fix/status");
  assert.deepEqual([fresh.kind, fresh.base], ["new", "origin/develop"], "a new branch starts from the remote's default branch");
  assert.equal(fresh.startIn, fresh.path, "from the root, Pi starts at the root");
  assert.equal(addWorktree(repo, "fix/other", { from: "feature/local" }).base, "feature/local");

  assert.throws(() => addWorktree(repo, "feature/local"), /feature\/local already has its folder: .*mono-feature-local\. Start Pi there\./);
  assert.throws(() => addWorktree(repo, "-x"), /Not a branch name/);
  assert.throws(() => addWorktree(repo, "fix/next", { from: "nope" }), /No branch or commit "nope" to start fix\/next from/);
  const [main, ...others] = worktrees(repo);
  assert.deepEqual([main.branch, main.main], ["develop", true], "the main folder comes first");
  assert.deepEqual(others.map((w) => w.branch).sort(), ["feature/local", "feature/remote-only", "fix/other", "fix/status"]);
});

test("/waicc-worktree lists branch folders with their sessions and changes, and removes one only when it is safe", async (t) => {
  const { repo, service } = monorepo(t);
  const commands = new Map<string, any>(), shown: string[] = [], notices: string[] = [], opened: string[] = [];
  const confirms: boolean[] = [];
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool() {}, on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
    sendMessage: (m: { content: string }) => shown.push(m.content), sendUserMessage() {},
  } as unknown as ExtensionAPI, { openTerminal: (path) => (opened.push(path), true) });
  const ctx = (cwd: string, hasUI = true) => ({
    cwd, mode: "tui", hasUI, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "wt-chat", getBranch: () => [] },
    ui: { notify: (m: string) => notices.push(m), confirm: async () => confirms.shift() ?? true },
  }) as unknown as ExtensionCommandContext;
  const run = (args: string, cwd = service, hasUI = true) => commands.get("waicc-worktree").handler(args, ctx(cwd, hasUI)).catch((e: Error) => notices.push(`error: ${e.message}`));

  // Only Windows asks whether to open a new terminal there.
  if (process.platform === "win32") confirms.push(true);
  await run("feature/local");
  assert.equal(confirms.length, 0);
  const folder = join(repo, "..", "mono-feature-local", "services", "orders");
  assert.match(notices.at(-1)!, /^Created .*mono-feature-local on your branch, with .* set up for WAICC like this service\. Start Pi in /);
  if (process.platform === "win32") assert.deepEqual(opened, [realpathSync.native(folder)], "and a new terminal opens there with Pi");

  createSession(folder, "Sync orders");
  writeFileSync(join(folder, "app.js"), "changed\n");
  await run("list");
  assert.match(shown.at(-1)!, /\*\*develop\*\* · .*mono · this chat · main folder/);
  assert.match(shown.at(-1)!, /\*\*feature\/local\*\* · .*mono-feature-local · 1 open WAICC session · 1 changed file/);

  await run("remove feature/local");
  assert.match(notices.at(-1)!, /has 1 changed or untracked file; commit, stash or discard them first\. Nothing was removed\./);
  git(join(repo, "..", "mono-feature-local"), "commit", "-q", "-am", "Change orders");
  await run("remove feature/local", service, false);
  assert.match(notices.at(-1)!, /needs your confirmation: 1 commit not pushed anywhere .*; 1 open WAICC session, which live in that folder/);
  confirms.push(false);
  await run("remove feature/local");
  assert.equal(notices.at(-1), "Nothing was removed.");
  assert.ok(existsSync(folder));
  confirms.push(true);
  await run("remove feature/local");
  assert.match(notices.at(-1)!, /^Removed .*mono-feature-local\. The branch feature\/local is kept/);
  assert.ok(!existsSync(folder));
  assert.equal(git(repo, "rev-parse", "--verify", "--quiet", "feature/local").length, 40, "the branch and its commit stay");

  await run("remove develop");
  assert.match(notices.at(-1)!, /main folder; it is never removed from here/);
  const other = addWorktree(repo, "fix/here");
  assert.throws(() => removeWorktree(other.path, "fix/here"), /This chat is working in that folder/);
});
