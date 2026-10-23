import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { prepareDispatch, runDispatch, type AgentRunner } from "../src/dispatch.ts";
import { loadAgentConfig } from "../src/profiles.ts";
import { projectStatus, sessionSpend } from "../src/tracker.ts";
import { chatUsage, totalUsage, usageMeter, usageText } from "../src/usage.ts";
import { createSession, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const lines = (...events: object[]) => events.map((event) => JSON.stringify(event));

test("each agent's own usage report is read: Claude's total, Codex's turns, Pi's messages", () => {
  const claude = usageMeter("claude");
  for (const line of lines(
    { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
    { type: "result", total_cost_usd: 0.75, usage: { input_tokens: 20, cache_creation_input_tokens: 57_869, cache_read_input_tokens: 375_045, output_tokens: 10_444 } },
  )) claude.read(line);
  assert.deepEqual(claude.get(), { inputTokens: 432_934, cachedTokens: 375_045, outputTokens: 10_444, costUsd: 0.75 });

  const codex = usageMeter("codex");
  for (const line of [...lines(
    { type: "turn.completed", usage: { input_tokens: 385_649, cached_input_tokens: 336_512, output_tokens: 2_859 } },
    { type: "turn.completed", usage: { input_tokens: 1_000, cached_input_tokens: 0, output_tokens: 100 } },
  ), "not json", "{\"type\":\"item.completed\"}"]) codex.read(line);
  assert.deepEqual(codex.get(), { inputTokens: 386_649, cachedTokens: 336_512, outputTokens: 2_959, costUsd: null }, "Codex reports no price");

  const pi = usageMeter("pi");
  for (const line of lines(
    { type: "message_end", message: { role: "user", usage: { input: 999 } } },
    { type: "message_end", message: { role: "assistant", usage: { input: 2_645, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0008 } } } },
    { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 1_000, cacheWrite: 0, cost: { total: 0.0002 } } } },
  )) pi.read(line);
  const piUsage = pi.get()!;
  assert.deepEqual({ ...piUsage, costUsd: Number(piUsage.costUsd!.toFixed(4)) }, { inputTokens: 3_745, cachedTokens: 1_000, outputTokens: 52, costUsd: 0.001 });

  assert.equal(usageMeter("claude").get(), null, "no report means no figures, not zero");
  const total = totalUsage([claude.get(), codex.get(), null]);
  assert.deepEqual([total.runs, total.unpricedRuns, total.costUsd], [2, 1, 0.75]);
  assert.equal(usageText(claude.get()), "$0.75 · 443k tokens");
  assert.equal(usageText(codex.get()), "390k tokens");
  // Past a thousand million it reads as billions, not "1281.0M".
  const big = { inputTokens: 1_277_600_000, outputTokens: 3_400_000, cachedTokens: 0, costUsd: null };
  assert.equal(usageText(big as Parameters<typeof usageText>[0]), "1.28B tokens");
  assert.equal(usageText({ ...big, inputTokens: 996_000_000 } as Parameters<typeof usageText>[0]), "999.4M tokens");
});

const contract: Contract = {
  title: "Search", requirements: [{ id: "R1", text: "Add search", sourceQuote: "Add search" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title: "Search", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"],
    acceptance: [{ id: "AC1", text: "Finds items", requirementIds: ["R1"], verification: "Search" }] }],
};
function project(t: TestContext, user?: unknown) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const root = join(base, "project"), agentDir = join(base, "agent");
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  if (user !== undefined) writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify(user));
  writeFileSync(join(root, "app.txt"), "app");
  const s = createSession(root, "Add search");
  prepare(root, s.id, contract, "planning", "Plan search", 0);
  return { root, id: s.id };
}

test("every dispatch records what it used, failed runs included, and the tracker totals it", async (t) => {
  const { root, id } = project(t);
  const run: AgentRunner = async () => ({
    stdout: `${lines({ type: "result", total_cost_usd: 1.25, usage: { input_tokens: 1_000, output_tokens: 500 } }).join("\n")}\n`,
    stderr: "", code: 1, killed: false,
  });
  const outcome = await runDispatch(prepareDispatch(root, id, { via: "claude" }), run);
  assert.equal(outcome.replySubmitted, false);
  assert.deepEqual(outcome.usage, { inputTokens: 1_000, cachedTokens: 0, outputTokens: 500, costUsd: 1.25 });
  assert.equal(JSON.parse(readFileSync(outcome.log!, "utf8")).usage.costUsd, 1.25);
  await runDispatch(prepareDispatch(root, id, { via: "claude" }), run);

  assert.equal(sessionSpend(root, id).costUsd, 2.5);
  const status = projectStatus(root, [], [], null, 5);
  const [s] = status.sessions;
  assert.equal(s.spend.costUsd, 2.5);
  assert.equal(s.rounds[0].attempts, 2);
  assert.equal(s.rounds[0].usage!.costUsd, 2.5);
  assert.deepEqual(status.runs.map((r) => [r.kind, r.mode, r.via, r.usage.costUsd]), [["dispatch", "planning", "claude", 1.25], ["dispatch", "planning", "claude", 1.25]]);
  assert.equal(status.budgetUsd, 5);
});

test("budget.perSessionUsd: a positive dollar amount, yours alone to set", (t) => {
  assert.equal(loadAgentConfig(project(t, { budget: { perSessionUsd: 4.5 } }).root).budget.perSessionUsd, 4.5);
  assert.equal(loadAgentConfig(project(t, {}).root).budget.perSessionUsd, null);
  for (const budget of [{ perSessionUsd: 0 }, { perSessionUsd: -1 }, { perSessionUsd: "5" }, { perSessionUsd: 20_000 }])
    assert.throws(() => loadAgentConfig(project(t, { budget }).root), /"budget.perSessionUsd" must be a dollar amount/);
  assert.throws(() => loadAgentConfig(project(t, { budget: { perDayUsd: 5 } }).root), /"budget" takes only "perSessionUsd"/);
  const shared = project(t);
  writeFileSync(join(shared.root, ".pi", "waicc-agents.json"), JSON.stringify({ budget: { perSessionUsd: 1 } }));
  assert.throws(() => loadAgentConfig(shared.root), /"budget" is allowed only in your user file/);
});

test("a Pi chat's main agent use is grouped by model and hour, from its assistant messages only", () => {
  const message = (timestamp: string, model: string, usage: unknown, role = "assistant") => ({ type: "message", timestamp, message: { role, provider: "openai", model, usage } });
  const hours = chatUsage([
    message("2026-10-20T09:10:00.000Z", "gpt-6.1", { input: 100, output: 10, cacheRead: 50, cacheWrite: 5, cost: { total: 0.1 } }),
    message("2026-10-20T09:50:00.000Z", "gpt-6.1", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } }),
    message("2026-10-20T10:01:00.000Z", "gpt-6.1", { input: 7, output: 3 }),
    message("2026-10-20T09:30:00.000Z", "gpt-6.1", { input: 999, output: 999 }, "user"),
    { type: "custom", timestamp: "2026-10-20T09:30:00.000Z", data: {} },
    message("not a time", "gpt-6.1", { input: 1, output: 1 }),
  ]);
  assert.deepEqual(hours.map((h) => [h.at, h.model, h.messages, h.usage.inputTokens, h.usage.cachedTokens, h.usage.outputTokens]), [
    ["2026-10-20T09:00:00.000Z", "openai/gpt-6.1", 2, 255, 50, 20],
    ["2026-10-20T10:00:00.000Z", "openai/gpt-6.1", 1, 7, 0, 3],
  ]);
  assert.ok(Math.abs(hours[0].usage.costUsd! - 0.3) < 1e-9);
  assert.equal(hours[1].usage.costUsd, null, "no reported price stays unpriced, not $0");
});

test("a reply's speed comes from when it was requested and saved, and $0 for real tokens means no price set", () => {
  const entry = (saved: string, seconds: number, usage: unknown) => ({ type: "message", timestamp: saved, message: { role: "assistant", provider: "hyper", model: "flash", timestamp: Date.parse(saved) - seconds * 1000, usage } });
  const [hour] = chatUsage([
    entry("2026-10-20T09:10:04.000Z", 4, { input: 100, output: 400, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }),
    entry("2026-10-20T09:20:06.000Z", 6, { input: 100, output: 600, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
    entry("2026-10-20T09:30:00.000Z", 0, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }),
  ]);
  assert.deepEqual([hour.seconds, hour.timedOutput], [10, 1000], "100 tokens per second over the two timed replies");
  assert.equal(hour.unpriced, 2, "$0 for real tokens is a missing price, not a free reply");
  assert.ok(Math.abs(hour.usage.costUsd! - 0.01) < 1e-9);
});

test("Claude on a claude.ai subscription is marked API-equivalent; with an API key it is a real charge", () => {
  const run = (apiKeySource: string) => {
    const meter = usageMeter("claude");
    meter.read(JSON.stringify({ type: "system", subtype: "init", apiKeySource }));
    meter.read(JSON.stringify({ type: "result", total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 20 } }));
    return meter.get()!;
  };
  assert.equal(run("none").costBasis, "api-equivalent");
  assert.equal(run("ANTHROPIC_API_KEY").costBasis, undefined);
  assert.equal(totalUsage([run("none"), run("ANTHROPIC_API_KEY")]).apiEquivalentUsd, 0.42);
  const pi = usageMeter("pi");
  pi.read(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: { input: 50, output: 5, cost: { total: 0 } } } }));
  assert.equal(pi.get()!.costUsd, null, "a Pi model with no price set reports $0, shown as without a price");
});
