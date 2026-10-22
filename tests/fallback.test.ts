import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { loadSession } from "../src/files.ts";
import type { AgentResult, AgentRunner } from "../src/dispatch.ts";
import { agentLimit } from "../src/limits.ts";
import { fallbackDispatch, loadAgentConfig } from "../src/profiles.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { assess, beginDevelopment, createSession, ingest, issue, prepare } from "../src/workflow.ts";
import type { Contract, WorkCompletion } from "../src/types.ts";

const run = (stdout: string, stderr = "", killed = false) => ({ stdout, stderr, killed });
const claudeLimited = [
  JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" }),
  JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1760000000" }),
].join("\n");

test("a limit is read from the agent's own error lines, never from files it read or its own words", () => {
  assert.deepEqual(agentLimit(run(claudeLimited)), { kind: "usage", text: "Claude AI usage limit reached|1760000000" });
  assert.equal(agentLimit(run(JSON.stringify({ type: "error", message: "stream error: 429 Too Many Requests" })))?.kind, "rate");
  assert.equal(agentLimit(run(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } })))?.kind, "usage");
  assert.equal(agentLimit(run(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "No API key found for provider" } })))?.kind, "signin");
  assert.equal(agentLimit(run("", "Invalid API key · Please run /login"))?.kind, "signin");
  assert.equal(agentLimit(run("", "spawn claude ENOENT"))?.kind, "missing");
  assert.equal(agentLimit(run("", "claude was not found on PATH. Install it and sign in, then dispatch again."))?.kind, "missing");

  // A file it read about rate limits, or its own last words, are not a limit.
  const read = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "export const rateLimit = 429; // quota exceeded" }] } });
  const said = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The API returns 429 when the rate limit is hit." }] } });
  assert.equal(agentLimit(run(`${read}\n${said}`)), null);
  assert.equal(agentLimit(run("", "TypeError: cannot read properties of undefined")), null);
  // Stopped or timed out: never a limit, whatever it printed.
  assert.equal(agentLimit(run(claudeLimited, "", true)), null);
});

const scope: Contract = {
  title: "Search", requirements: [{ id: "R1", text: "Search with account isolation", sourceQuote: "Add search with account isolation" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "API", title: "API", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["API.txt"],
    acceptance: [{ id: "AC0", text: "Search respects account isolation", requirementIds: ["R1"], verification: "Run search regression checks" }] }],
};
const answer = (findings: { id: string; description: string }[] = []) => ({
  outcome: findings.length ? "needs_changes" : "ready", summary: "Independently inspected the whole change",
  coverage: [{ requirementId: "R1", status: "addressed", evidence: "API.txt and AC0 inspected" }],
  findings: findings.map((finding) => ({ ...finding, severity: "medium", evidence: "API.txt violates AC0" })),
  questions: [], checks: [{ description: "Read API", outcome: "passed", evidence: "Source inspected" }],
});
const report = (): WorkCompletion => ({
  summary: "All work complete", tasks: [{ taskId: "API", evidence: "API.txt implements AC0" }],
  checks: [{ description: "Search regression checks", outcome: "passed", evidence: "Fixture evidence" }], findings: [],
});
const waitFor = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(check(), `timed out waiting for ${what}`);
};
const settle = () => new Promise((done) => setTimeout(done, 100));

/** A code review waiting, with the review role on opus, whose fallback is sol unless given. */
function reviewWaiting(t: TestContext, profiles: Record<string, unknown> = { opus: { via: "claude", model: "opus", fallback: "sol" }, sol: { via: "codex", model: "gpt-5" } }) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, ".pi"));
  writeFileSync(join(root, ".pi", "waicc-agents.json"), JSON.stringify({ profiles, roles: { review: "opus" } }));
  writeFileSync(join(root, "API.txt"), "original API");
  const s = createSession(root, "Add search with account isolation", undefined, "planning");
  prepare(root, s.id, scope, "planning", "Plan", 0);
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, { ...answer(), outcome: "planned" });
  assess(root, s.id, { requestId: ingest(root, s.id).rounds.at(-1)!.id, decision: "planned", rationale: "Checked", dispositions: [] });
  beginDevelopment(root, s.id, "main");
  writeFileSync(join(root, "API.txt"), "implemented API");
  issue(root, s.id, "review", "Review the whole change", undefined, undefined, { kind: "code", completion: report() });
  return { root, id: s.id };
}

/** Pi with scripted agents: each program either fails as given or submits the next review. */
function harness(root: string, id: string, fails: Record<string, AgentResult>, replies: ReturnType<typeof answer>[]) {
  const commands = new Map<string, any>(), hooks = new Map<string, any>();
  const shown: any[] = [], notices: string[] = [], prompts: string[] = [], entries: any[] = [], programs: string[] = [];
  const agent: AgentRunner = async (program) => {
    programs.push(program);
    if (fails[program]) return fails[program];
    const body = replies.shift();
    if (body) submitRecipientReply(root, receiveHandoff(root, id).pin, body);
    return { stdout: "", stderr: "", code: 0, killed: false };
  };
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool() {}, on: (n: string, h: any) => hooks.set(n, h),
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
    sendMessage: (m: any) => shown.push(m), sendUserMessage: (m: string) => prompts.push(m),
  } as unknown as ExtensionAPI, { runAgent: agent });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "fallback-chat", getBranch: () => entries },
    ui: { notify: (m: string) => notices.push(m) },
  } as unknown as ExtensionCommandContext;
  return {
    shown, notices, prompts, programs,
    use: () => commands.get("waicc-use").handler(id, ctx),
    dispatch: (args: string) => commands.get("waicc-dispatch").handler(args, ctx),
    turnEnds: () => hooks.get("agent_end")({}, ctx),
    outcomes: () => shown.filter((m) => m.customType === "waicc-dispatch").map((m) => JSON.parse(m.content)),
    fallbacks: () => shown.filter((m) => m.customType === "waicc-dispatch-fallback").map((m) => m.content as string),
    loopMessages: () => shown.filter((m) => m.customType === "waicc-review-loop").map((m) => m.content as string),
  };
}
const limited = { stdout: claudeLimited, stderr: "", code: 1, killed: false };

test("profiles name a fallback: it must exist and not be the profile itself; it swaps the agent and keeps the run", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".pi"));
  const write = (profiles: unknown) => writeFileSync(join(root, ".pi", "waicc-agents.json"), JSON.stringify({ profiles }));
  write({ opus: { via: "claude", fallback: "nope" } });
  assert.throws(() => loadAgentConfig(root), /Profile opus falls back to "nope", which no agent config defines/);
  write({ opus: { via: "claude", fallback: "opus" } });
  assert.throws(() => loadAgentConfig(root), /Profile opus cannot be its own fallback/);
  write({ opus: { via: "claude", fallback: 3 } });
  assert.throws(() => loadAgentConfig(root), /profile opus: fallback must be another profile's name/);

  write({ opus: { via: "claude", model: "opus", effort: "high", fallback: "sol" }, sol: { via: "codex", model: "gpt-5", timeoutMinutes: 40 }, plain: { via: "pi" } });
  const checks = [{ program: "npm", args: ["test"], timeoutMs: 600_000 }];
  assert.deepEqual(fallbackDispatch(root, { via: "claude", model: "opus", effort: "high", implement: true, checks, continue: true, loop: 2 }, "opus"), {
    profile: "sol",
    options: { via: "codex", model: "gpt-5", timeoutMinutes: 40, implement: true, checks, continue: true, loop: 2 },
  });
  assert.equal(fallbackDispatch(root, { via: "pi" }, "plain"), null);
});

test("a usage-limited dispatch is retried once with the profile's fallback, visibly, and both runs are logged", async (t) => {
  const { root, id } = reviewWaiting(t);
  const h = harness(root, id, { claude: limited }, [answer()]);
  await h.use();
  await h.dispatch("");
  await waitFor(() => h.outcomes().length === 2, "the retry");
  assert.deepEqual(h.programs, ["claude", "codex"]);
  assert.match(h.fallbacks()[0], /^opus \(claude\) hit its usage limit: "Claude AI usage limit reached\|1760000000"\. Retrying the same handoff once with your sol profile \(codex gpt-5\)\.$/);
  const [first, second] = h.outcomes();
  assert.equal(first.replySubmitted, false);
  assert.equal(first.limit.kind, "usage");
  assert.match(first.nextAction, /claude hit its usage limit/);
  assert.equal(second.replySubmitted, true);
  assert.deepEqual(second.fallbackFrom, { profile: "opus", dispatchId: first.dispatchId, reason: "opus (claude) hit its usage limit" });
  assert.equal(ingest(root, id).status, "AWAITING_ASSESSMENT");
});

test("no retry without a fallback, for other failures, or a second time", async (t) => {
  const none = reviewWaiting(t, { opus: { via: "claude" } });
  const a = harness(none.root, none.id, { claude: limited }, []);
  await a.use();
  await a.dispatch("");
  await waitFor(() => a.outcomes().length === 1, "the run");
  await settle();
  assert.deepEqual(a.programs, ["claude"]);
  assert.match(a.outcomes()[0].nextAction, /claude hit its usage limit/);

  const crash = reviewWaiting(t);
  const b = harness(crash.root, crash.id, { claude: { stdout: "", stderr: "TypeError: boom", code: 1, killed: false } }, []);
  await b.use();
  await b.dispatch("");
  await waitFor(() => b.outcomes().length === 1, "the run");
  await settle();
  assert.deepEqual(b.programs, ["claude"], "a crash is not a limit");

  // Both limited: the fallback's own fallback is not followed.
  const both = reviewWaiting(t, { opus: { via: "claude", fallback: "sol" }, sol: { via: "codex", fallback: "opus" } });
  const c = harness(both.root, both.id, { claude: limited, codex: { stdout: JSON.stringify({ type: "error", message: "429 Too Many Requests" }), stderr: "", code: 1, killed: false } }, []);
  await c.use();
  await c.dispatch("");
  await waitFor(() => c.outcomes().length === 2, "the retry");
  await settle();
  assert.deepEqual(c.programs, ["claude", "codex"]);
  assert.equal(c.fallbacks().length, 1);
});

test("in a loop, the fallback takes over for the rest of the run", async (t) => {
  const { root, id } = reviewWaiting(t);
  const h = harness(root, id, { claude: limited }, [answer([{ id: "F1", description: "Missing account check" }]), answer()]);
  await h.use();
  await h.dispatch("--loop 2");
  await waitFor(() => h.prompts.length === 1, "the first assessment");
  assert.match(h.fallbacks()[0], /the rest of this run uses it too\.$/);

  // The main agent fixes and asks for a fresh review: it goes straight to sol.
  const requestId = loadSession(root, id).rounds.at(-1)!.id;
  assess(root, id, { requestId, decision: "needs_changes", rationale: "Verified", dispositions: [] });
  writeFileSync(join(root, "API.txt"), "fixed API");
  const completion = report();
  completion.findings = [{ requestId, findingId: "F1", disposition: "resolved", evidence: "Fixed" }];
  issue(root, id, "review", "Review again", undefined, undefined, { kind: "code", completion });
  await h.turnEnds();
  await waitFor(() => h.prompts.length === 2, "the second assessment");
  assert.deepEqual(h.programs, ["claude", "codex", "codex"]);
  assert.deepEqual(h.outcomes().at(-1).fallbackFrom, { profile: "opus", dispatchId: null, reason: "opus hit a limit earlier in this run" });
  assert.equal(h.fallbacks().length, 1, "announced once");
});
