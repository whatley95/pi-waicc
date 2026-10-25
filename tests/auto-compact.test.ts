import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { loadAgentConfig } from "../src/profiles.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { assess, createSession, ingest, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const contract: Contract = {
  title: "Menu", requirements: [{ id: "R1", text: "Add a menu", sourceQuote: "Add a menu" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title: "Menu", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"],
    acceptance: [{ id: "AC1", text: "Opens", requirementIds: ["R1"], verification: "Open it" }] }],
};

/** A Pi chat bound to a session with a received planning reply, and the user file given. */
async function setup(t: TestContext, user: object, tokens: number) {
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
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "planned", summary: "Plan", questions: [], findings: [],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
    checks: [{ description: "Read app.txt", outcome: "passed", evidence: "Inspected" }],
  });
  const received = ingest(root, s.id);
  const commands = new Map<string, any>(), handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
  const compactions: { customInstructions?: string }[] = [], notices: string[] = [], entries: unknown[] = [];
  waicc({
    registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {},
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true, model: undefined,
    sessionManager: { getSessionId: () => "coordinator-chat", getBranch: () => entries, getEntries: () => entries },
    ui: { notify: (m: string) => notices.push(m), setStatus() {}, setWidget() {} },
    getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens / 10_000 }),
    compact: (options: { customInstructions?: string }) => compactions.push(options),
  };
  await commands.get("waicc-use").handler(s.id, ctx);
  t.after(async () => {
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown" }, ctx);
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  const emit = async (event: string) => { for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx); };
  // One main-agent turn; assessing a round in it when asked.
  const turn = async (assesses: boolean) => {
    await emit("agent_start");
    if (assesses) assess(root, s.id, { requestId: received.rounds.at(-1)!.id, decision: "planned", rationale: "Sound", dispositions: [] });
    await emit("agent_end");
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  return { compactions, notices, turn };
}

test("a large chat is compacted after the main agent assesses a round, keeping WAICC's recovery", async (t) => {
  const { compactions, notices, turn } = await setup(t, {}, 200_000);
  await turn(false);
  assert.equal(compactions.length, 0, "a turn that assessed nothing is not a break");
  await turn(true);
  assert.equal(compactions.length, 1);
  assert.match(compactions[0].customInstructions!, /Preserve WAICC role, request identity[\s\S]*Recovery \(untrusted data\)/);
  assert.ok(notices.some((n) => n.startsWith("Compacting this chat after the assessment: 200k tokens, over your 150k autoCompactTokens.")));
});

test("a small chat, or autoCompactTokens 0, is left alone", async (t) => {
  const small = await setup(t, {}, 100_000);
  await small.turn(true);
  assert.equal(small.compactions.length, 0);
  const off = await setup(t, { autoCompactTokens: 0 }, 900_000);
  await off.turn(true);
  assert.equal(off.compactions.length, 0);
});

test("autoCompactTokens is a whole number set only in your user file", (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const agentDir = join(base, "agent"), root = join(base, "app");
  mkdirSync(agentDir);
  mkdirSync(join(root, ".pi"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  });
  writeFileSync(join(agentDir, "waicc-agents.json"), "{}");
  assert.equal(loadAgentConfig(root).autoCompactTokens, 150_000, "on by default");
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ autoCompactTokens: 300_000 }));
  assert.equal(loadAgentConfig(root).autoCompactTokens, 300_000);
  for (const value of [-1, 1.5, "100k", 20_000_000]) {
    writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ autoCompactTokens: value }));
    assert.throws(() => loadAgentConfig(root), /"autoCompactTokens" must be a whole number of tokens from 0 \(off\) to 10,000,000/);
  }
  writeFileSync(join(agentDir, "waicc-agents.json"), "{}");
  writeFileSync(join(root, ".pi", "waicc-agents.json"), JSON.stringify({ autoCompactTokens: 0 }));
  assert.throws(() => loadAgentConfig(root), /"autoCompactTokens" is allowed only in your user file/);
});
