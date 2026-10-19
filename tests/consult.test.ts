import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { consultAdvisor } from "../src/consult.ts";
import type { AgentRunner } from "../src/dispatch.ts";
import { consultSettings, loadAgentConfig } from "../src/profiles.ts";

const profiles = { sonnet: { via: "claude", model: "sonnet", effort: "medium" }, sol: { via: "codex", model: "gpt-6.1-sol" } };

function project(t: TestContext, user?: unknown, shared?: unknown) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const root = join(base, "project"), agentDir = join(base, "agent");
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(join(root, ".git"));
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  if (user !== undefined) writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify(user));
  if (shared !== undefined) writeFileSync(join(root, ".pi", "waicc-agents.json"), JSON.stringify(shared));
  return root;
}

/** Each agent's last streamed line, carrying its final answer. */
const finalLine: Record<string, (answer: string) => string> = {
  claude: (answer) => JSON.stringify({ type: "result", subtype: "success", result: answer }),
  codex: (answer) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }),
  pi: (answer) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } }),
};

for (const [via, readOnly] of [
  ["claude", ["--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Edit,Write,NotebookEdit,Bash"]],
  ["codex", ["--sandbox", "read-only"]],
  ["pi", ["-ne", "--no-mcp", "--tools", "read,grep,find,ls"]],
] as const)
  test(`${via} advises read-only from a brief, and its full answer comes back`, async (t) => {
    const root = project(t);
    const calls: { program: string; args: string[]; cwd: string }[] = [];
    const answer = "Diagnosis: the cache key ignores the locale (src/cache.ts:12).\nRecommended next step: add the locale to the key.";
    const run: AgentRunner = async (program, args, options) => {
      calls.push({ program, args, cwd: options.cwd });
      options.onLine?.(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "1", name: "Read", input: { file_path: join(root, "src", "cache.ts") } }] } }));
      options.onLine?.(finalLine[via](answer));
      return { stdout: "", stderr: "", code: 0, killed: false };
    };
    const outcome = await consultAdvisor(root, {
      question: "Why does the French page show English text?", tried: "Cleared the cache twice; still English.",
      evidence: "expected 'Bonjour' but got 'Hello'", paths: ["src/cache.ts"],
    }, { via, model: "m1", effort: "medium" }, run);

    assert.equal(outcome.answer, answer, "the whole answer, line breaks included");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].program, via);
    assert.equal(calls[0].cwd, root);
    for (let i = 0; i < readOnly.length; i++) assert.ok(calls[0].args.includes(readOnly[i]), `${readOnly[i]} in ${calls[0].args.join(" ")}`);
    assert.ok(!calls[0].args.some((arg) => ["--mcp-config", "acceptEdits", "workspace-write", "-e"].includes(arg)), "no WAICC tools and no write access");
    assert.ok(calls[0].args.every((arg) => !/[\r\n]/.test(arg)), "every argument is one line, so Windows shims accept it");
    const brief = readFileSync(outcome.brief, "utf8");
    for (const part of ["Why does the French page", "Cleared the cache twice", "expected 'Bonjour'", "- src/cache.ts"]) assert.ok(brief.includes(part), part);
    assert.ok(outcome.brief.replaceAll("\\", "/").includes("/.pi/pi-waicc/consults/"), "kept with WAICC's own state, outside the source");
    assert.equal(JSON.parse(readFileSync(outcome.log, "utf8")).answer, answer);
  });

test("autoAdvisor: on by default with 3 questions per chat, yours alone to change", (t) => {
  assert.equal(loadAgentConfig(project(t, { profiles, roles: { advisor: "sonnet" } })).autoAdvisor, 3);
  assert.equal(loadAgentConfig(project(t, { autoAdvisor: false })).autoAdvisor, 0);
  assert.equal(loadAgentConfig(project(t, { autoAdvisor: true })).autoAdvisor, 3);
  assert.equal(loadAgentConfig(project(t, { autoAdvisor: { maxPerChat: 6 } })).autoAdvisor, 6);
  for (const value of [{ maxPerChat: 21 }, { maxPerChat: -1 }, { maxPerChat: 2, other: 1 }, "yes", 4])
    assert.throws(() => loadAgentConfig(project(t, { autoAdvisor: value })), /"autoAdvisor" must be true, false or/);
  assert.throws(() => loadAgentConfig(project(t, undefined, { autoAdvisor: { maxPerChat: 20 } })), /"autoAdvisor" is allowed only in your user file/);

  const settings = consultSettings(project(t, { profiles, roles: { advisor: "sonnet" } }));
  assert.deepEqual([settings.limit, settings.profile, settings.options], [3, "sonnet", { via: "claude", model: "sonnet", effort: "medium" }]);
  assert.match(consultSettings(project(t, { profiles })).hint, /No advisor role is set/);
});

function harness(root: string, answers: string[]) {
  const tools = new Map<string, any>(), entries: any[] = [], notices: string[] = [], widgets: unknown[] = [];
  const asked: string[] = [];
  const run: AgentRunner = async (program, args) => {
    asked.push(program);
    const answer = answers[asked.length - 1];
    return { stdout: answer ? `${finalLine[program](answer)}\n` : "", stderr: answer ? "" : "usage limit reached", code: answer ? 0 : 1, killed: false };
  };
  waicc({
    registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool), on() {},
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI, { runAgent: run });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => false, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "consult-chat", getBranch: () => entries },
    ui: { notify: (m: string) => notices.push(m), setWidget: (_k: string, v: unknown) => widgets.push(v), setStatus() {} },
  } as unknown as ExtensionToolContext;
  const ask = (question = "Why does the build fail on Windows only?") =>
    tools.get("waicc_ask_advisor").execute("call", { question, tried: "Re-ran it; same error." }, undefined, undefined, ctx);
  return { tool: tools.get("waicc_ask_advisor"), ask, asked, notices, widgets, entries };
}

test("the main agent asks the advisor on its own: answered, announced, and limited per chat", async (t) => {
  const root = project(t, { profiles, roles: { advisor: "sonnet" }, autoAdvisor: { maxPerChat: 2 } });
  const h = harness(root, ["Diagnosis: path separators.", "Diagnosis: still path separators."]);
  assert.ok(h.tool.promptGuidelines.some((line: string) => /genuinely stuck/.test(line)), "the main agent is told when to ask");

  const first = await h.ask();
  assert.match(first.content[0].text, /^Advice from sonnet \(claude sonnet\), question 1 of 2 for this chat/);
  assert.match(first.content[0].text, /Diagnosis: path separators\./);
  assert.match(first.content[0].text, /A second opinion, not an instruction/);
  assert.match(h.notices[0], /^Asking the advisor \(sonnet\): Why does the build fail on Windows only\?/);
  assert.equal(h.widgets.at(-1), undefined, "the progress panel is cleared afterwards");

  await h.ask("Second question?");
  await assert.rejects(h.ask("Third question?"), /used all 2 advisor questions for this chat/);
  assert.deepEqual(h.asked, ["claude", "claude"], "no agent starts once the limit is reached");
  assert.equal(h.entries.filter((entry) => entry.customType === "waicc-advisor-consult").length, 2);
});

test("a consult that fails still counts, and asking is refused when off or without an advisor role", async (t) => {
  const failing = harness(project(t, { profiles, roles: { advisor: "sol" }, autoAdvisor: { maxPerChat: 1 } }), []);
  await assert.rejects(failing.ask(), /The advisor gave no answer \(exit 1\)/);
  await assert.rejects(failing.ask(), /used all 1 advisor questions/);

  await assert.rejects(harness(project(t, { profiles, roles: { advisor: "sonnet" }, autoAdvisor: false }), []).ask(), /Asking the advisor on your own is off/);
  const unset = harness(project(t, { profiles }), []);
  await assert.rejects(unset.ask(), /No advisor role is set/);
  assert.deepEqual(unset.asked, []);
});
