import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runInNewContext } from "node:vm";
import { forgetSources, projectStatus, publish, type LiveRun, type ProjectStatus } from "../src/tracker.ts";
import { recordPipeline } from "../src/pipelines.ts";
import { addToQueue, updateQueue } from "../src/queue.ts";
import { planShip, requestOpener, ship } from "../src/ship.ts";
import { closeShipped, status } from "../src/workflow.ts";
import { reviewed } from "./ship-fixture.ts";

/** Its own tracker folder, so the page data written here is this test's alone. */
function trackerFolder(t: TestContext): string {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, tracker: process.env.WAICC_TRACKER };
  process.env.PI_CODING_AGENT_DIR = base;
  delete process.env.WAICC_TRACKER;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous.dir;
    process.env.WAICC_TRACKER = previous.tracker;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  return join(base, "waicc-tracker");
}
const pageData = (tracker: string) => {
  let data: { projects: (ProjectStatus & { interrupted: { label: string }[] })[] } | undefined;
  runInNewContext(readFileSync(join(tracker, "data.js"), "utf8"), { window: { waiccTracker: (d: typeof data) => (data = d) } });
  return JSON.parse(JSON.stringify(data!.projects)) as NonNullable<typeof data>["projects"];
};
function renderPage(projects: unknown[]): string {
  const elements: Record<string, { innerHTML: string; textContent: string }> = { app: { innerHTML: "", textContent: "" }, updated: { innerHTML: "", textContent: "" } };
  const window: Record<string, any> = {};
  const script = /<script>([\s\S]*)<\/script>/.exec(readFileSync(new URL("../templates/tracker.html", import.meta.url), "utf8"))![1];
  runInNewContext(script, {
    window, location: { hash: "" }, history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {} },
    setInterval() {}, document: {
      getElementById: (name: string) => elements[name] ?? { addEventListener() {} },
      addEventListener() {}, querySelectorAll: () => [], createElement: () => ({ remove() {} }), body: { appendChild() {} },
    },
  });
  window.waiccTracker({ generatedAt: new Date().toISOString(), projects });
  return elements.app.innerHTML;
}
const run = (label: string): LiveRun => ({ kind: "dispatch", sessionId: null, label, startedAt: Date.now(), steps: [], said: null });

test("a passed code review offers /waicc-ship; once the code changes it shows stale, as /waicc-status does", (t) => {
  const { root, id } = reviewed(t);
  const before = projectStatus(root);
  assert.equal(before.sessions[0].status, "READY_TO_CLOSE");
  assert.equal(before.sessions[0].staleReason, null);
  assert.deepEqual(before.needsYou.map((n) => [n.text, n.command]), [["Review passed: ship it, or close it", "/waicc-ship"]]);
  assert.ok(!("approvedSource" in before.sessions[0]), "what it compares stays off the page");

  writeFileSync(join(root, "API.txt"), "changed after the review");
  forgetSources();
  const after = projectStatus(root);
  assert.equal((status(root, id) as { status: string }).status, "STALE");
  assert.equal(after.sessions[0].status, "STALE");
  assert.equal(after.sessions[0].staleReason, "The code changed after the passing review");
  assert.deepEqual(after.needsYou.map((n) => [n.text, n.command]), [["The code changed after the passing review: ask for a fresh review", "/waicc-review"]]);
  const page = renderPage([JSON.parse(JSON.stringify(after))]);
  assert.match(page, /The code changed after the passing review: this pass no longer holds/);
});

test("a shipped change shows its merge request and pipeline; a failed pipeline needs you", async (t) => {
  const { root, id } = reviewed(t);
  const plan = planShip(root, id);
  const shipped = await ship(plan, await requestOpener(plan, {
    host: () => ({ token: "glpat-test", allowHttp: false }), origin: async (project) => project,
    gitlab: () => async (method) => (method === "GET" ? [] : { iid: 12, web_url: "https://gitlab.example.com/team/app/-/merge_requests/12" }),
  }));
  closeShipped(root, id, shipped);
  recordPipeline(root, id, { state: "failed", text: "The pipeline failed: unit.", url: "https://gitlab.example.com/team/app/-/pipelines/7", commit: shipped.commit });
  const view = projectStatus(root);
  const [s] = view.sessions;
  assert.equal(s.status, "CLOSED");
  assert.deepEqual([s.shipped?.number, s.shipped?.url, s.shipped?.target], [12, "https://gitlab.example.com/team/app/-/merge_requests/12", "main"]);
  assert.deepEqual([s.pipeline?.state, s.pipeline?.url], ["failed", "https://gitlab.example.com/team/app/-/pipelines/7"]);
  assert.deepEqual(view.needsYou.map((n) => [n.text, n.command]), [["The pipeline failed for MR !12", "/waicc-reopen <reason>"]]);
  const page = renderPage([JSON.parse(JSON.stringify(view))]);
  assert.match(page, /href="https:\/\/gitlab\.example\.com\/team\/app\/-\/merge_requests\/12"[^>]*>MR !12 → main ↗/);
  assert.match(page, /class="pill bad"[^>]*>CI failed ↗/);
  assert.match(page, /<span class="pill bad" title="The pipeline failed: unit\.">CI failed<\/span>/, "on the card, without a link inside its button");

  // A mark from an earlier commit is not this change's pipeline.
  recordPipeline(root, id, { state: "passed", text: "The pipeline passed.", url: null, commit: "0".repeat(40) });
  assert.equal(projectStatus(root).sessions[0].pipeline, null);
});

test("the overnight queue is on the page: what waits, what runs and where it has got to", (t) => {
  const { root } = reviewed(t);
  addToQueue(root, "Add paging");
  addToQueue(root, "Dark <b>mode</b>");
  updateQueue(root, (q) => Object.assign(q.items[0], { status: "running", step: "running: plan, code, review, ship", folder: join(root, "..", "app-queue-1") }));
  const view = projectStatus(root);
  assert.equal(view.queue?.waiting, 1);
  assert.deepEqual(view.queue?.items.map((i) => [i.id, i.status, i.step]), [[1, "running", "running: plan, code, review, ship"], [2, "waiting", null]]);
  const page = renderPage([JSON.parse(JSON.stringify(view))]);
  assert.match(page, /Overnight queue · 1 waiting/);
  assert.match(page, /running: plan, code, review, ship/);
  assert.match(page, /queue · 1 running · 1 waiting/);
  assert.match(page, /Dark &lt;b&gt;mode&lt;\/b&gt;/);
});

test("a Pi that is gone shows its runs as interrupted; another Pi's runs in the same project stay", async (t) => {
  const tracker = trackerFolder(t);
  const shop = reviewed(t), orders = reviewed(t);
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => other.kill());
  await new Promise((started) => other.once("spawn", started));

  // A crashed Pi left orders' file with a run still going.
  publish(projectStatus(orders.root));
  const ordersKey = projectStatus(orders.root).key;
  const ordersFile = join(tracker, "projects", `${ordersKey}.json`);
  writeFileSync(ordersFile, JSON.stringify({ ...JSON.parse(readFileSync(ordersFile, "utf8")), pid: gone, live: [run("WAICC · codex coding")] }));
  // A second Pi, still running, is reviewing in shop when this one writes shop.
  const shopKey = projectStatus(shop.root).key;
  const shopFile = join(tracker, "projects", `${shopKey}.json`);
  publish(projectStatus(shop.root));
  writeFileSync(shopFile, JSON.stringify({ ...JSON.parse(readFileSync(shopFile, "utf8")), pid: other.pid, live: [run("WAICC · sol reviewing")] }));
  publish(projectStatus(shop.root, [run("WAICC · claude planning")]));

  const projects = pageData(tracker);
  const shopped = projects.find((p) => p.key === shopKey)!, ordered = projects.find((p) => p.key === ordersKey)!;
  assert.deepEqual(shopped.live.map((r) => [r.label, r.pid]), [["WAICC · claude planning", process.pid], ["WAICC · sol reviewing", other.pid]]);
  assert.deepEqual(shopped.interrupted, []);
  assert.deepEqual(ordered.live, []);
  assert.deepEqual(ordered.interrupted.map((r) => r.label), ["WAICC · codex coding"]);
  assert.match(renderPage(projects), /Pi closed while codex coding was running/);

  // Once the other Pi is gone, this Pi's next write drops its runs.
  other.kill();
  await new Promise((exited) => other.once("exit", exited));
  publish(projectStatus(shop.root));
  assert.deepEqual(pageData(tracker).find((p) => p.key === shopKey)!.live, []);
});
