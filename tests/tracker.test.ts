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
import { prepareDispatch, runDispatch, type AgentRunner } from "../src/dispatch.ts";
import { runPace } from "../src/usage.ts";
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

/** Renders the page's script on these projects, on one tab; returns the app's markup. */
function renderPage(projects: unknown[], tab = "overview", tokens = "today", spend = "today"): string {
  const elements: Record<string, { innerHTML: string; textContent: string }> = { app: { innerHTML: "", textContent: "" }, updated: { innerHTML: "", textContent: "" } };
  const window: Record<string, any> = {};
  const script = /<script>([\s\S]*)<\/script>/.exec(readFileSync(new URL("../templates/tracker.html", import.meta.url), "utf8"))![1];
  runInNewContext(script, {
    window, location: { hash: "" }, history: { replaceState() {} }, localStorage: { getItem: (k: string) => (k === "waicc-tab" ? tab : k === "waicc-tokens" ? tokens : k === "waicc-spend" ? spend : null), setItem() {} },
    setInterval() {}, document: {
      getElementById: (name: string) => elements[name] ?? { addEventListener() {} },
      addEventListener() {}, querySelectorAll: () => [], createElement: () => ({ remove() {} }), body: { appendChild() {} },
    },
  });
  window.waiccTracker({ generatedAt: new Date().toISOString(), projects });
  return elements.app.innerHTML;
}

test("the main agent's model and use in every Pi chat of a project are counted, apart from the agents WAICC sent work to", async (t) => {
  const { project } = setup(t);
  const { root } = project("shop");
  const handlers = new Map<string, any>();
  waicc({
    registerCommand() {}, registerTool() {}, on: (name: string, h: any) => handlers.set(name, h), appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const hour = new Date();
  hour.setMinutes(5, 0, 0);
  const at = (minutes: number) => new Date(hour.getTime() + minutes * 60_000).toISOString();
  const said = (minutes: number, model: string, cost: number | undefined, input = 1000) => ({
    type: "message", id: `m${minutes}`, parentId: null, timestamp: at(minutes),
    // Stamped 2 s before it was saved: 200 output tokens in 2 s.
    message: { role: "assistant", provider: "anthropic", model, timestamp: Date.parse(at(minutes)) - 2000, usage: { input, output: 200, cacheRead: 500, cacheWrite: 0, totalTokens: input + 700, cost: cost === undefined ? undefined : { total: cost } } },
  });
  const chat = (id: string, name: string | undefined, model: string, entries: unknown[]) => ({
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    model: { provider: "anthropic", id: model },
    sessionManager: { getSessionId: () => id, getBranch: () => [], getEntries: () => entries, getSessionName: () => name },
    ui: { notify() {} },
  });
  const first = chat("chat-a", "Fix checkout", "claude-opus-5-5", [
    { type: "message", id: "u1", parentId: null, timestamp: at(0), message: { role: "user", content: "Fix checkout" } },
    said(1, "claude-opus-5-5", 0.4), said(20, "claude-opus-5-5", 0.6), said(50, "claude-sonnet-5-5", 0.1),
  ]);
  const second = chat("chat-b", undefined, "claude-haiku-5-5", [said(2, "claude-haiku-5-5", 0.05)]);
  await handlers.get("session_shutdown")({}, first);
  await new Promise((resolve) => setTimeout(resolve, 5)); // So the second chat is the latest one.
  await handlers.get("session_shutdown")({}, second);

  const status = JSON.parse(JSON.stringify(projectStatus(root)));
  assert.deepEqual(status.chats.map((c: any) => [c.chatId, c.name, c.model]).sort(),
    [["chat-a", "Fix checkout", "anthropic/claude-opus-5-5"], ["chat-b", null, "anthropic/claude-haiku-5-5"]]);
  const main = status.runs.filter((r: any) => r.kind === "main");
  const opus = main.find((r: any) => r.model === "anthropic/claude-opus-5-5");
  assert.equal(opus.messages, 2, "one model's messages in one hour are one figure");
  assert.equal(opus.usage.inputTokens, 3000, "input counts cached tokens too");
  assert.equal(opus.usage.cachedTokens, 1000);
  assert.ok(Math.abs(opus.usage.costUsd - 1) < 1e-9);
  assert.equal(main.reduce((n: number, r: any) => n + r.messages, 0), 4, "only the main agent's own messages count");

  const overview = renderPage([status]);
  assert.match(overview, /main agent · claude-haiku-5-5, claude-opus-5-5/, "each chat's model, the latest chat first");
  assert.match(overview, /<h3>Main agent<\/h3>/);
  assert.match(overview, /Fix checkout/);
  assert.match(overview, /Pi chat chat-b/);
  assert.match(overview, /also claude-sonnet-5-5/);
  assert.match(overview, /<th>Speed<\/th>/);
  assert.match(overview, />100 tok\/s<\/td>/, "200 output tokens in 2 s of producing each reply");
  assert.match(overview, /Main agent \$1\.15/, "the summary strip says who used today's spend");
  assert.match(overview, /<span>Tokens<\/span><span class="seg"><button type="button" data-range="tokens:today" class="on">Today<\/button>[\s\S]*?<div class="value">7k<\/div>/);
  assert.match(overview, /<span>Spent<\/span><span class="seg"><button type="button" data-range="spend:today" class="on">Today<\/button>[\s\S]*?<div class="value">\$1\.15<\/div>/);
  const everything = renderPage([status], "overview", "all");
  assert.match(everything, /data-range="tokens:all" class="on">All<\/button>[\s\S]*?<div class="value">7k<\/div>/, "All counts everything recorded");
  assert.match(everything, /since [^<·]*\d{4} · \$1\.15/, "the date is in the viewer's own format");
  const spentAll = renderPage([status], "overview", "today", "all");
  assert.match(spentAll, /data-range="spend:all" class="on">All<\/button>[\s\S]*?<div class="value">\$1\.15<\/div>[\s\S]*?Main agent \$1\.15<\/div><div class="sub">since /, "the spend box has its own switch, with who spent it");
  assert.match(overview, /input 4k<\/span><span><b class="cached"><\/b>cached 2k<\/span><span><b class="out"><\/b>output 800/, "and today's fresh input, cached input and output are labelled");
  assert.match(overview, /class="tokbar"/);
  assert.match(overview, /<div class="sub">main agent 7k<\/div>/, "and who used them");
  assert.match(overview, /0<\/div><div class="sub">agents working/, "working agents and what needs you share one box");
  const spendTokens = renderPage([status], "spend");
  assert.match(spendTokens, /All time<\/div>[\s\S]*?in 6k \(2k cached\) · out 800/);
  const spend = renderPage([status], "spend");
  assert.match(spend, /By who/);
  assert.match(spend, /main agent anthropic\/claude-opus-5-5/);
  assert.match(spend, /4 messages/);

  // An unchanged chat is not saved again; a new message is.
  const savedAt = () => projectStatus(root).chats.find((c) => c.chatId === "chat-a")!.updatedAt;
  const before = savedAt();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await handlers.get("session_shutdown")({}, first);
  assert.equal(savedAt(), before);
  first.sessionManager.getEntries().push(said(55, "claude-opus-5-5", 0.2));
  await handlers.get("session_shutdown")({}, first);
  assert.notEqual(savedAt(), before);
  assert.equal(projectStatus(root).runs.filter((r) => r.kind === "main").reduce((n, r) => n + r.messages!, 0), 5);

  // The page's run list keeps the latest 2,000 figures; the all-time totals count every one.
  const long = Array.from({ length: 2100 }, (_, i) => ({
    type: "message", id: `h${i}`, parentId: null, timestamp: new Date(hour.getTime() - i * 3_600_000).toISOString(),
    message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { total: 0.01 } } },
  }));
  await handlers.get("session_shutdown")({}, chat("chat-long", "Long chat", "claude-opus-5-5", long));
  const big = projectStatus(root);
  assert.equal(big.runs.length, 2000);
  assert.equal(big.allTime.byKind.main.messages, 2105);
  assert.equal(big.allTime.byKind.main.inputTokens, 2100 * 10 + 7500);
  assert.equal(big.allTime.byKind.dispatch.runs, 0);
  assert.ok(Date.parse(big.allTime.since!) <= hour.getTime() - 2099 * 3_600_000);
  assert.match(renderPage([JSON.parse(JSON.stringify(big))], "overview", "all"), /<div class="value">32k<\/div>/, "31.6k tokens from 2,105 messages, beyond the run list");
});

test("the tracker shows what the main agent is working on during its turn, step by step", async (t) => {
  const { agentDir, project } = setup(t);
  const { root } = project("shop");
  const handlers = new Map<string, any>(), commands = new Map<string, any>();
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool() {}, on: (name: string, h: any) => handlers.set(name, h), appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI, { openPage: () => true });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => false, isProjectTrusted: () => true, model: { provider: "anthropic", id: "claude-opus-5-5" },
    sessionManager: { getSessionId: () => "main-chat", getBranch: () => [], getEntries: () => [], getSessionName: () => undefined }, ui: { notify() {} },
  } as unknown as ExtensionCommandContext;
  const live = async () => {
    await commands.get("waicc-tracker").handler("", ctx);
    let data: { projects: ProjectStatus[] } | undefined;
    runInNewContext(readFileSync(join(agentDir, "waicc-tracker", "data.js"), "utf8"), { window: { waiccTracker: (d: typeof data) => (data = d) } });
    return JSON.parse(JSON.stringify(data!.projects.find((p) => p.root === root)!.live)) as ProjectStatus["live"];
  };

  await handlers.get("agent_start")({}, ctx);
  await handlers.get("tool_execution_start")({ toolCallId: "1", toolName: "read", args: { path: join(root, "app.txt") } }, ctx);
  await handlers.get("tool_execution_start")({ toolCallId: "2", toolName: "bash", args: { command: "npm test" } }, ctx);
  await handlers.get("message_end")({ message: { role: "assistant", content: [{ type: "text", text: "Tests pass; now updating the menu." }] } }, ctx);
  const [run] = await live();
  assert.equal(run.kind, "main");
  assert.equal(run.label, "Main agent · claude-opus-5-5 working");
  assert.deepEqual(run.steps.map((s) => s.text), ["Reading app.txt", "Running npm test"]);
  assert.equal(run.said, "Tests pass; now updating the menu.");
  assert.match(renderPage([{ ...JSON.parse(JSON.stringify(projectStatus(root, [run]))) }]), /Main agent · claude-opus-5-5 working/, "shown on the card and in the overview");

  await handlers.get("agent_end")({}, ctx);
  assert.deepEqual(await live(), [], "gone when its turn ends");
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

test("agents are compared per step: runs, how often they replied, time and cost per run, and how kept replies ended", async (t) => {
  const { base } = setup(t);
  const root = join(base, "compare");
  mkdirSync(root);
  writeFileSync(join(root, "app.txt"), "app");
  const s = createSession(root, "Add a side menu", undefined, "planning");
  prepare(root, s.id, contract("Side menu"), "planning", "Plan", 0);
  const usage = (cost: number) => `${JSON.stringify({ type: "result", total_cost_usd: cost, usage: { input_tokens: 1_000, output_tokens: 6_000 } })}\n`;
  // Claude stops without a reply; Codex answers.
  await runDispatch(prepareDispatch(root, s.id, { via: "claude" }), async () => ({ stdout: usage(0.5), stderr: "", code: 1, killed: false }));
  const codex: AgentRunner = async () => {
    submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
      outcome: "planned", summary: "Menu plan", findings: [], questions: [],
      coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
      checks: [{ description: "Read app.txt", outcome: "passed", evidence: "Inspected" }],
    });
    return { stdout: `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2_000, cached_input_tokens: 0, output_tokens: 3_000 } })}\n`, stderr: "", code: 0, killed: false };
  };
  await runDispatch(prepareDispatch(root, s.id, { via: "codex" }), codex);
  ingest(root, s.id);
  const status = projectStatus(root);
  assert.deepEqual(status.runs.map((r) => [r.via, r.replied, r.outcome]).sort(), [["claude", false, null], ["codex", true, "planned"]]);
  const page = renderPage([JSON.parse(JSON.stringify(status))], "spend");
  assert.match(page, /<h3>Agents compared, per step<\/h3>/);
  assert.match(page, /<td>claude \(default model\)<\/td><td>planning<\/td><td>1<\/td><td>0%<\/td>[\s\S]*?<td>\$0\.50<\/td>/);
  assert.match(page, /<td>codex \(default model\)<\/td><td>planning<\/td><td>1<\/td><td>100%<\/td>[\s\S]*?<td>5k tok<\/td>[\s\S]*?<td class="small">planned 1<\/td>/);
  assert.equal(runPace({ inputTokens: 1, cachedTokens: 0, outputTokens: 38_000, costUsd: null }, 270_000), "38k out, 8k/min");
  assert.equal(runPace({ inputTokens: 1, cachedTokens: 0, outputTokens: 0, costUsd: null }, 270_000), null);
  assert.equal(runPace(null, 270_000), null);
});
