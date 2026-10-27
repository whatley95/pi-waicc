import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { loadSession } from "../src/files.ts";
import { parseDispatchArgs } from "../src/dispatch.ts";
import { planShip, requestOpener, ship } from "../src/ship.ts";
import { closeShipped } from "../src/workflow.ts";
import { changedIn, git, reviewed } from "./ship-fixture.ts";

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

test("a session planned from an issue ships on a branch named after it, and its merge request closes it", async (t) => {
  const { root, id } = reviewed(t, undefined, { provider: "gitlab", remote: "origin", number: 42, url: null, title: "Add paging", author: "alice" });
  const plan = planShip(root, id);
  assert.equal(plan.branch, "waicc/42-search-with-paging");
  assert.match(plan.description, /^> 🤖[^\n]*\n\nCloses #42\n\n## Requirements/);
  const options = (await requestOpener(plan, { host: () => null, origin: async (project) => project })).pushOptions!;
  assert.ok(options.some((option) => option.startsWith("merge_request.description=Closes #42. Planned, coded and reviewed")));
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
