import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { createSession, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const contract: Contract = {
  title: "Menu", requirements: [{ id: "R1", text: "Add a menu", sourceQuote: "Add a menu" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title: "Menu", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"],
    acceptance: [{ id: "AC1", text: "Opens", requirementIds: ["R1"], verification: "Open it" }] }],
};

/** A handed-off planning request in a project whose user file sets autoContinue, and a Pi chat bound to it. */
async function setup(t: TestContext, user: object) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const agentDir = join(base, "agent"), root = join(base, "app");
  mkdirSync(agentDir);
  mkdirSync(root);
  writeFileSync(join(root, "app.txt"), "app");
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify(user));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const s = createSession(root, "Add a menu");
  prepare(root, s.id, contract, "planning", "Plan", 0);
  const commands = new Map<string, any>(), handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
  const prompts: string[] = [], notices: string[] = [], entries: unknown[] = [];
  let idle = true;
  waicc({
    registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {},
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {},
    sendUserMessage: (content: string) => prompts.push(content),
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => idle, isProjectTrusted: () => true, model: undefined,
    sessionManager: { getSessionId: () => "coordinator-chat", getBranch: () => entries, getEntries: () => entries },
    ui: { notify: (m: string) => notices.push(m), setStatus() {}, setWidget() {} },
  };
  await commands.get("waicc-use").handler(s.id, ctx);
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx);
  // The chat ends (stopping its watcher) before its project is removed.
  t.after(async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  // The other agent writes its reply the way a recipient does.
  const write = () => submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "planned", summary: "Plan", questions: [], findings: [],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
    checks: [{ description: "Read app.txt", outcome: "passed", evidence: "Inspected" }],
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const wait = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 3_000) { t.mock.timers.tick(3_000); await settle(); await settle(); }
  };
  return { prompts, notices, write, wait, setIdle: (value: boolean) => (idle = value) };
}

test("with autoContinue on, a reply to a handoff given out by hand is taken in and assessed once, without /waicc-continue", async (t) => {
  const { prompts, notices, write, wait, setIdle } = await setup(t, { autoContinue: true });
  await wait(6_000);
  assert.equal(prompts.length, 0, "nothing happens before a reply exists");
  write();
  // Not while the main agent is working.
  setIdle(false);
  await wait(9_000);
  assert.equal(prompts.length, 0);
  setIdle(true);
  await wait(6_000);
  assert.equal(prompts.length, 1, "the main agent is asked to assess, once");
  assert.match(prompts[0], /Assess the reply BEFORE application edits/);
  assert.ok(notices.includes("A reply to your handoff arrived; continuing automatically (autoContinue)."));
  await wait(9_000);
  assert.equal(prompts.length, 1, "an assessed or received reply is never taken in twice");
});

test("with autoContinue false in your user file nothing is taken in automatically", async (t) => {
  const { prompts, write, wait } = await setup(t, { autoContinue: false });
  write();
  await wait(36_000);
  assert.equal(prompts.length, 0);
});
