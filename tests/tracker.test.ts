import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runInNewContext } from "node:vm";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { projectStatus, publish, trackerEnabled, trackerPage, type ProjectStatus } from "../src/tracker.ts";
import { assess, createSession, ingest, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const contract = (title: string): Contract => ({
  title, requirements: [{ id: "R1", text: "Add a side menu", sourceQuote: "Add a side menu" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title: "Menu", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"],
    acceptance: [{ id: "AC1", text: "Menu opens", requirementIds: ["R1"], verification: "Open the menu" }] }],
  decisions: [{ id: "D1", question: "Left or right side?", owner: "human", status: "open", affectedTaskIds: ["T1"],
    evidence: ["app.txt has room on both sides"], recommendation: "Left", risk: "medium", reversible: true }],
});

/** A tracker folder and a project whose plan was accepted with one decision still open. */
function setup(t: TestContext, title = "Side menu") {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const agentDir = join(base, "agent");
  mkdirSync(agentDir);
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, tracker: process.env.WAICC_TRACKER };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.WAICC_TRACKER;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous.dir;
    process.env.WAICC_TRACKER = previous.tracker;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  const project = (name: string, projectTitle = title) => {
    const root = join(base, name);
    mkdirSync(root);
    writeFileSync(join(root, "app.txt"), "app");
    const s = createSession(root, "Add a side menu", undefined, "planning");
    prepare(root, s.id, contract(projectTitle), "planning", "Plan", 0);
    submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
      outcome: "planned", summary: "Menu plan, one decision for the human", findings: [], questions: [],
      coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
      checks: [{ description: "Read app.txt", outcome: "passed", evidence: "Inspected" }],
    });
    const received = ingest(root, s.id);
    assess(root, s.id, { requestId: received.rounds.at(-1)!.id, decision: "planned", rationale: "Plan matches the source", dispositions: [] });
    return { root, id: s.id };
  };
  return { base, agentDir, project };
}

test("a project's status: its sessions, contract, timeline, and what needs the human", (t) => {
  const { project } = setup(t);
  const { root, id } = project("shop");
  const status = projectStatus(root, [{ kind: "dispatch", sessionId: id, label: "WAICC · sol reviewing", startedAt: Date.now(), steps: [], said: null }]);
  assert.equal(status.name, "shop");
  const [s] = status.sessions;
  assert.equal(s.id, id);
  assert.equal(s.title, "Side menu");
  assert.equal(s.status, "PLAN_READY");
  assert.deepEqual(s.tasks, [{ id: "T1", title: "Menu", reported: false }]);
  assert.deepEqual(s.decisions.map((d) => [d.id, d.status, d.recommendation]), [["D1", "open", "Left"]]);
  assert.deepEqual(s.rounds.map((r) => [r.n, r.mode, r.outcome, r.decision, r.checks.length]), [[1, "planning", "planned", "planned", 1]]);
  // The session is busy, so only the decision is listed, not "start development".
  assert.deepEqual(status.needsYou.map((n) => n.command), ["/waicc-decide D1 recommended"]);
  assert.deepEqual(projectStatus(root).needsYou.map((n) => n.command), ["/waicc-decide D1 recommended", "/waicc-develop"]);
});

test("every project shares one page: each writes its own status, the page data holds them all", (t) => {
  const { agentDir, project } = setup(t);
  const shop = project("shop"), orders = project("orders");
  const page = publish(projectStatus(shop.root));
  assert.equal(page, trackerPage());
  assert.equal(page, join(agentDir, "waicc-tracker", "index.html"));
  assert.equal(readFileSync(page, "utf8"), readFileSync(new URL("../templates/tracker.html", import.meta.url), "utf8"));
  publish(projectStatus(orders.root));

  const read = () => {
    let data: { projects: ProjectStatus[] } | undefined;
    runInNewContext(readFileSync(join(agentDir, "waicc-tracker", "data.js"), "utf8"), { window: { waiccTracker: (d: typeof data) => (data = d) } });
    return JSON.parse(JSON.stringify(data!.projects)) as ProjectStatus[]; // Out of the script's own realm.
  };
  assert.deepEqual(read().map((p) => p.name).sort(), ["orders", "shop"]);
  // A project that no longer exists drops off the page.
  rmSync(orders.root, { recursive: true, force: true });
  publish(projectStatus(shop.root));
  assert.deepEqual(read().map((p) => p.name), ["shop"]);
});

test("the page renders cards, the needs-you list and details, and never runs text from sessions", (t) => {
  const { project } = setup(t);
  const { root, id } = project("shop", "<img src=x onerror=alert(1)>");
  const status = projectStatus(root, [{ kind: "dispatch", sessionId: id, label: "WAICC · codex coding", startedAt: Date.now() - 65_000,
    steps: [{ at: 1000, kind: "step", text: "Editing <b>menu.tsx</b>" }], said: "Working on T1" }]);
  const elements: Record<string, { innerHTML: string; textContent: string }> = { app: { innerHTML: "", textContent: "" }, updated: { innerHTML: "", textContent: "" } };
  const window: Record<string, any> = {};
  const html = readFileSync(new URL("../templates/tracker.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  runInNewContext(script, {
    window, location: { hash: "" }, history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {} },
    setInterval() {}, document: {
      getElementById: (name: string) => elements[name] ?? { addEventListener() {} },
      addEventListener() {}, querySelectorAll: () => [], createElement: () => ({ remove() {} }), body: { appendChild() {} },
    },
  });
  window.waiccTracker({ generatedAt: new Date().toISOString(), projects: [status] });
  const page = elements.app.innerHTML;
  assert.match(page, /Needs you \(1\)/);
  assert.match(page, /\/waicc-decide D1 recommended/);
  assert.match(page, /codex coding/);
  assert.match(page, /Editing &lt;b&gt;menu\.tsx&lt;\/b&gt;/);
  assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!page.includes("<img"), "session text is shown as text, never as markup");
  assert.match(page, /Left or right side\?/);
  assert.match(elements.updated.textContent, /^1 project · updated/);

  // A Pi started before an update writes its project without spend: the page still shows it.
  const { runs: _runs, budgetUsd: _budget, ...older } = status;
  const olderSessions = older.sessions.map(({ spend: _spend, rounds, ...s }) => ({ ...s, rounds: rounds.map(({ usage: _u, attempts: _a, ...r }) => r) }));
  window.waiccTracker({ generatedAt: new Date(Date.now() + 1000).toISOString(), projects: [{ ...older, sessions: olderSessions }] });
  assert.match(elements.app.innerHTML, /codex coding/);
  assert.match(elements.app.innerHTML, /older version · restart Pi/);
  assert.doesNotMatch(elements.app.innerHTML, /could not show/);
});

test("/waicc-tracker opens the page; off stops every update, on resumes; dispatched agents never write it", async (t) => {
  const { agentDir, project } = setup(t);
  const { root } = project("shop");
  const commands = new Map<string, any>(), opened: string[] = [], notices: string[] = [];
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool() {}, on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI, { openPage: (path) => (opened.push(path), true) });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "tracker-chat", getBranch: () => [] }, ui: { notify: (m: string) => notices.push(m) },
  } as unknown as ExtensionCommandContext;
  const tracker = join(agentDir, "waicc-tracker");

  await commands.get("waicc-tracker").handler("", ctx);
  assert.deepEqual(opened, [join(tracker, "index.html")]);
  assert.ok(existsSync(join(tracker, "data.js")));

  await commands.get("waicc-tracker").handler("off", ctx);
  assert.equal(trackerEnabled(), false);
  await commands.get("waicc-tracker").handler("", ctx);
  assert.match(notices.at(-1)!, /The tracker is off\. \/waicc-tracker on turns it back on\./);
  await commands.get("waicc-tracker").handler("on", ctx);
  assert.equal(trackerEnabled(), true);
  assert.equal(opened.length, 2);

  process.env.WAICC_DISPATCH_PIN = "session:request";
  t.after(() => { delete process.env.WAICC_DISPATCH_PIN; });
  assert.equal(trackerEnabled(), false, "a dispatched agent's own Pi leaves the page to the coordinator");
});
