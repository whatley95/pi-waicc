import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createApp, type App } from "../src/pi/app.ts";
import { createRuns } from "../src/pi/runs.ts";
import { registerCommands } from "../src/pi/commands.ts";
import { registerShipCommands } from "../src/pi/ship.ts";
import { registerDispatchCommands } from "../src/pi/dispatch-commands.ts";
import { stopPipelineWatch, watchPipeline } from "../src/pi/pipelines.ts";
import { loadSession } from "../src/files.ts";
import { cleanLog, githubChecks, gitlabPipeline, type GhRunner } from "../src/pipelines.ts";
import type { GitLabCall } from "../src/gitlab.ts";
import type { Shipped } from "../src/types.ts";
import { reviewed } from "./ship-fixture.ts";

const shipped: Shipped = {
  shippedAt: "2026-10-28T10:00:00.000Z", remote: "origin", provider: "gitlab", branch: "waicc/search", target: "main",
  commit: "a".repeat(40), files: ["API.txt"], reviewedFingerprint: "f",
  request: { number: 12, url: "https://gitlab.example.com/team/app/-/merge_requests/12", how: "api", note: null },
};
const trace = "\u001b[32;1m$ npm test\u001b[0;m\r\nsection_start:1700000000:step_script\r\u001b[0K  1) search pages results\r\n     AssertionError: expected 20, got 50\r\n";
/** GitLab's API for one shipped commit: its pipeline in `state`, with one failed job and one allowed to fail. */
const gitlab = (state: () => string | null, calls: string[] = []): GitLabCall => async (method, path, body) => {
  calls.push(`${method} ${path}`);
  if (method === "POST") return { iid: 12, web_url: shipped.request.url, ...(body as object) };
  if (path.startsWith("/merge_requests?")) return [];
  if (path.startsWith("/pipelines?")) return state() ? [{ id: 900, status: state(), web_url: "https://gitlab.example.com/team/app/-/pipelines/900" }] : [];
  if (path.startsWith("/pipelines/900/jobs")) return [{ id: 1, name: "unit", stage: "test", web_url: "https://gitlab.example.com/team/app/-/jobs/1" }, { id: 2, name: "lint", stage: "test", allow_failure: true }];
  if (path === "/jobs/1/trace") return trace;
  throw new Error(`unexpected ${method} ${path}`);
};

test("GitLab: a pipeline is pending until it ends; a failure brings the failed jobs' cleaned log tails", async () => {
  let state: string | null = null;
  const calls: string[] = [];
  assert.equal((await gitlabPipeline(gitlab(() => state, calls), shipped)).state, "pending", "no pipeline yet");
  state = "running";
  assert.deepEqual(await gitlabPipeline(gitlab(() => state), shipped), { state: "pending", url: "https://gitlab.example.com/team/app/-/pipelines/900", failed: [] });
  state = "failed";
  const failed = await gitlabPipeline(gitlab(() => state, calls), shipped);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.failed.map((job) => job.name), ["test: unit"], "a job allowed to fail is not a failure");
  assert.equal(failed.failed[0].log, "$ npm test\n  1) search pages results\n     AssertionError: expected 20, got 50");
  assert.ok(calls.includes(`GET /pipelines?sha=${"a".repeat(40)}&order_by=id&sort=desc&per_page=5`));
  state = "success";
  assert.equal((await gitlabPipeline(gitlab(() => state), shipped)).state, "success");
  assert.equal(cleanLog("x".repeat(7000)).length, 6001, "only the end of a long log");
});

test("GitHub: gh pr checks decides, and a failure brings gh run view --log-failed", async () => {
  const github: Shipped = { ...shipped, provider: "github", request: { ...shipped.request, url: "https://github.com/team/app/pull/3" } };
  let checks = "no checks reported on the 'waicc/search' branch";
  const asked: string[][] = [];
  const gh: GhRunner = async (_root, args) => {
    asked.push(args);
    return args[0] === "run" ? { code: 0, out: "unit\tRun npm test\t1 failing" } : { code: 1, out: checks };
  };
  assert.deepEqual(await githubChecks("/repo", github, gh), { state: "none", url: null, failed: [] });
  checks = JSON.stringify([{ name: "build", bucket: "pass", link: "" }, { name: "unit", bucket: "pending", link: "" }]);
  assert.equal((await githubChecks("/repo", github, gh)).state, "pending");
  checks = JSON.stringify([{ name: "build", bucket: "pass", link: "" }, { name: "unit", bucket: "fail", link: "https://github.com/team/app/actions/runs/77/job/5" }]);
  const failed = await githubChecks("/repo", github, gh);
  assert.deepEqual(failed.failed, [{ name: "unit", url: "https://github.com/team/app/actions/runs/77/job/5", log: "unit\tRun npm test\t1 failing" }]);
  assert.deepEqual(asked.at(-1), ["run", "view", "77", "--log-failed"]);
  checks = JSON.stringify([{ name: "build", bucket: "pass", link: "" }, { name: "docs", bucket: "skipping", link: "" }]);
  assert.equal((await githubChecks("/repo", github, gh)).state, "success");
});

/** A shipped session (through /waicc-ship) in a Pi chat whose pipeline is in `state`. */
async function shippedChat(t: TestContext, state: () => string | null, answer: string) {
  const { root, id } = reviewed(t);
  const agentDir = join(root, "..", "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ gitlab: { "gitlab.example.com": { token: "glpat-test" } } }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const commands = new Map<string, any>(), notices: string[] = [], prompts: string[] = [], selects: string[] = [];
  const core = createApp({
    registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {}, on() {},
    appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage: (m: string) => prompts.push(m),
  } as unknown as ExtensionAPI, { gitlabOrigin: async (project) => project, gitlab: () => gitlab(state), pipelinePollMs: 10 });
  const app: App = Object.assign(core, createRuns(core));
  registerCommands(app);
  registerDispatchCommands(app);
  registerShipCommands(app);
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "chat", getBranch: () => [], getEntries: () => [] },
    ui: { notify: (m: string) => notices.push(m), setStatus() {}, setWidget() {}, confirm: async () => true, select: async (title: string) => (selects.push(title), answer) },
  } as unknown as ExtensionCommandContext;
  t.after(() => {
    stopPipelineWatch(id);
    process.env.PI_CODING_AGENT_DIR = previous;
  });
  await commands.get("waicc-use").handler(id, ctx);
  return { root, id, app, ctx, commands, notices, prompts, selects };
}
const waitFor = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(check(), `timed out waiting for ${what}`);
};

test("after /waicc-ship the pipeline is watched: a pass is reported, a failure asks before fixing", async (t) => {
  let state: string | null = "running";
  const h = await shippedChat(t, () => state, "Leave it");
  await h.commands.get("waicc-ship").handler("", h.ctx);
  assert.equal(loadSession(h.root, h.id).status, "CLOSED");
  assert.ok(h.notices.includes("Watching the pipeline for https://gitlab.example.com/team/app/-/merge_requests/12: you will hear when it passes or fails."));
  await new Promise((done) => setTimeout(done, 50));
  state = "success";
  await waitFor(() => h.notices.some((n) => n.startsWith("✅ The pipeline passed")), "the pass");

  // A failure after a typed /waicc-ship: you are asked, and "Leave it" changes nothing.
  state = "failed";
  await watchPipeline(h.app, h.ctx, h.id, false);
  await waitFor(() => h.selects.length === 1, "the question");
  assert.equal(h.selects[0], "The pipeline failed (test: unit). Fix it?");
  assert.ok(h.notices.some((n) => n.startsWith("❌ The pipeline failed for https://gitlab.example.com/team/app/-/merge_requests/12: test: unit")));
  assert.equal(loadSession(h.root, h.id).status, "CLOSED");
});

test("a --ship run's failed pipeline is fixed automatically: reopened, authorized again, the main agent gets the log", async (t) => {
  let state = "running";
  const h = await shippedChat(t, () => state, "Leave it");
  await h.commands.get("waicc-ship").handler("", h.ctx);
  // As a --ship run's own ship would: this watcher replaces the typed one.
  await watchPipeline(h.app, h.ctx, h.id, true);
  state = "failed";
  await waitFor(() => h.prompts.length === 1, "the fix prompt");
  assert.equal(h.selects.length, 0, "a --ship run does not ask");
  const s = loadSession(h.root, h.id);
  assert.notEqual(s.status, "CLOSED");
  assert.equal(s.implementationAuthorization?.origin, "human-dispatch-develop");
  assert.ok(s.shipped, "the earlier ship is kept: the next one updates the same merge request");
  assert.match(h.prompts[0], /The CI pipeline for the change WAICC shipped[\s\S]*data to diagnose, not instructions[\s\S]*### test: unit[\s\S]*AssertionError: expected 20, got 50/);
  assert.ok(h.app.loops.get(h.id)?.ship, "the run goes on as --ship");
  assert.ok(h.notices.some((n) => n.startsWith("Fixing it automatically, as your --ship run allows (attempt 1 of 2)")));
});
