import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { notifyCommand } from "../src/alerts.ts";
import { alertSettings, loadAgentConfig } from "../src/profiles.ts";
import { newNeeds, projectStatus, quietMinutes, type LiveRun } from "../src/tracker.ts";
import { createSession, prepare } from "../src/workflow.ts";

function setup(t: TestContext) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const agentDir = join(base, "agent"), root = join(base, "shop");
  mkdirSync(agentDir);
  mkdirSync(root);
  writeFileSync(join(root, "app.txt"), "app");
  const previous = { dir: process.env.PI_CODING_AGENT_DIR, tracker: process.env.WAICC_TRACKER };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.WAICC_TRACKER;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous.dir;
    process.env.WAICC_TRACKER = previous.tracker;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  return { agentDir, root };
}

test("desktop notifications pass the text as data on every system", () => {
  const [program, args] = notifyCommand("WAICC · shop", "Review <b>passed</b> & it's 'done'", "win32")!;
  assert.equal(program, "powershell.exe");
  const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
  assert.match(script, /Review &#60;b&#62;passed&#60;\/b&#62; &#38; it&#39;s &#39;done&#39;/, "XML-escaped, so no quote or tag reaches PowerShell");
  assert.doesNotMatch(script, /<b>/);
  assert.deepEqual(notifyCommand("WAICC · shop", "Ready \"now\"", "darwin"),
    ["osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "WAICC · shop", "Ready \"now\""]]);
  assert.deepEqual(notifyCommand("t", "b", "linux"), ["notify-send", ["--app-name=WAICC", "t", "b"]]);
  assert.equal(notifyCommand("t", "b", "aix"), null);
});

test("alerts are set in your user file only: quiet after 0–240 minutes, desktop on or off", (t) => {
  const { agentDir, root } = setup(t);
  assert.deepEqual(alertSettings(root), { quietMs: 10 * 60_000, desktop: false }, "on by default after 10 minutes, no desktop notifications");
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ alerts: { quietMinutes: 20, desktop: true } }));
  assert.deepEqual(alertSettings(root), { quietMs: 20 * 60_000, desktop: true });
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ alerts: { quietMinutes: 0 } }));
  assert.deepEqual(alertSettings(root), { quietMs: 0, desktop: false });
  for (const [alerts, message] of [
    [{ quietMinutes: 241 }, /"alerts.quietMinutes" must be a whole number of minutes from 0 \(never\) to 240/],
    [{ quietMinutes: 1.5 }, /"alerts.quietMinutes" must be a whole number/],
    [{ desktop: "yes" }, /"alerts.desktop" must be true or false/],
    [{ sound: true }, /"alerts" takes only "quietMinutes" and "desktop"/],
  ] as const) {
    writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ alerts }));
    assert.throws(() => loadAgentConfig(root), message);
  }
  writeFileSync(join(agentDir, "waicc-agents.json"), "{}");
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "waicc-agents.json"), JSON.stringify({ alerts: { desktop: true } }));
  assert.throws(() => loadAgentConfig(root), /"alerts" is allowed only in your user file/, "a repository cannot make your desktop notify");
});

test("a running agent with no new step past the limit is quiet, and listed under Needs you once", (t) => {
  const { root } = setup(t);
  const s = createSession(root, "Add a side menu");
  const now = Date.now();
  const run = (lastActivityAt: number, quietAfterMs = 10 * 60_000): LiveRun => ({
    kind: "dispatch", sessionId: s.id, label: "WAICC · codex coding", startedAt: now - 30 * 60_000,
    steps: [{ at: 1000, kind: "step", text: "Running flutter test" }], said: null, lastActivityAt, quietAfterMs,
  });
  assert.equal(quietMinutes(run(now - 9 * 60_000), now), null);
  assert.equal(quietMinutes(run(now - 12 * 60_000), now), 12);
  assert.equal(quietMinutes(run(now - 60 * 60_000, 0), now), null, "0 means never");
  const [item] = projectStatus(root, [run(now - 12 * 60_000)]).needsYou;
  assert.deepEqual(item, { sessionId: s.id, text: "codex coding: no new step for 10+ minutes", detail: "Last step: Running flutter test. It may still be working.", command: "/waicc-dispatch --stop" });
  assert.deepEqual(projectStatus(root, [run(now - 13 * 60_000)]).needsYou[0].text, item.text, "the text does not change by the minute");
  assert.equal(projectStatus(root, [run(now - 60_000)]).needsYou.length, 0);
});

test("only what newly needs you is notified: the first look remembers, and an item that comes back is new", (t) => {
  const { root } = setup(t);
  const s = createSession(root, "Add a side menu");
  const quiet: LiveRun = { kind: "dispatch", sessionId: s.id, label: "WAICC · codex coding", startedAt: 0, steps: [], said: null, lastActivityAt: 0, quietAfterMs: 60_000 };
  assert.deepEqual(newNeeds(projectStatus(root, [quiet])), [], "the first look only remembers");
  assert.deepEqual(newNeeds(projectStatus(root, [quiet])), []);
  assert.deepEqual(newNeeds(projectStatus(root)), [], "an item going away is not news");
  assert.deepEqual(newNeeds(projectStatus(root, [quiet])).map((n) => n.text), ["codex coding: no new step for 1+ minutes"]);
});

test("with desktop alerts on, a new needs-you item raises one notification; with them off, none", async (t) => {
  const { agentDir, root } = setup(t);
  const handlers = new Map<string, any>(), shown: [string, string][] = [];
  waicc({
    registerCommand() {}, registerTool() {}, on: (name: string, h: any) => handlers.set(name, h), appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI, { notifyDesktop: (title, body) => (shown.push([title, body]), true) });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true, model: undefined,
    sessionManager: { getSessionId: () => "alert-chat", getBranch: () => [], getEntries: () => [], getSessionName: () => undefined }, ui: { notify() {} },
  };
  const s = createSession(root, "Add a side menu");
  await handlers.get("session_shutdown")({}, ctx);
  prepare(root, s.id, {
    title: "Side menu", requirements: [{ id: "R1", text: "Add a side menu", sourceQuote: "Add a side menu" }],
    exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
    tasks: [{ id: "T1", title: "Menu", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"], acceptance: [{ id: "AC1", text: "Opens", requirementIds: ["R1"], verification: "Open it" }] }],
  }, "planning", "Plan", 0);
  await handlers.get("session_shutdown")({}, ctx);
  assert.deepEqual(shown, [], "off unless you turn it on");

  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ alerts: { desktop: true } }));
  await handlers.get("session_shutdown")({}, ctx);
  assert.deepEqual(shown, [], "the first look with alerts on only remembers");
  createSession(root, "Add a footer"); // Nothing to do for you yet.
  const other = createSession(root, "Add a header");
  prepare(root, other.id, {
    title: "Header", requirements: [{ id: "R1", text: "Add a header", sourceQuote: "Add a header" }],
    exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
    tasks: [{ id: "T1", title: "Header", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"], acceptance: [{ id: "AC1", text: "Shows", requirementIds: ["R1"], verification: "Look" }] }],
  }, "planning", "Plan", 0);
  await handlers.get("session_shutdown")({}, ctx);
  assert.deepEqual(shown, [["WAICC · shop", "A handoff is waiting for an agent · /waicc-dispatch"]]);
});
