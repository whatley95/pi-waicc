import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { autoPlanningMode } from "../src/auto-planning.ts";
import { digest, listSessions, loadSession, sessionRelative } from "../src/files.ts";
import { createAutoPlanningSession, createSession, forceCloseSession, prepare } from "../src/workflow.ts";
import { deleteSession } from "../src/lifecycle.ts";

function fixture(t: TestContext): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-auto-")));
  t.after(() => {
    assert.equal(dirname(root), realpathSync.native(tmpdir()));
    assert.ok(basename(root).startsWith("waicc-auto-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "app.txt"), "existing source");
  return root;
}
function harness(root: string, entries: any[] = [], chatId = "auto-chat") {
  const commands = new Map<string, any>(), tools = new Map<string, any>(), hooks = new Map<string, any>();
  const shown: any[] = [], notices: string[] = [], prompts: string[] = [], copies: string[] = [];
  let active = ["read", "edit", "write", "bash", "waicc_status", "waicc_prepare", "waicc_start_planning", "waicc_reply"];
  waicc({ registerCommand: (n: string, c: any) => commands.set(n, c), registerTool: (t: any) => tools.set(t.name, t),
    on: (n: string, h: any) => hooks.set(n, h), appendEntry: (customType: string, data: any) => {
      entries.push({ type: "custom", customType, data });
    },
    getAllTools: () => active.map((name) => ({ name })), getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    sendMessage: (m: any) => shown.push(JSON.parse(m.content)), sendUserMessage: (m: string) => prompts.push(m),
  } as unknown as ExtensionAPI, { copyText: async (text) => { copies.push(text); } });
  const ctx = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => chatId, getBranch: () => entries },
    ui: { notify: (m: string) => notices.push(m) },
  } as unknown as ExtensionCommandContext;
  const tool = async (name: string, params: any, signal?: AbortSignal) => {
    const result = await tools.get(name).execute("fixture", params, signal, undefined, ctx);
    return JSON.parse(result.content[0].text);
  };
  const command = (name: string, args = "") => commands.get(name).handler(args, ctx);
  const input = (text: string, extra = {}) => hooks.get("input")({ type: "input", text, source: "interactive", ...extra }, ctx);
  const begin = (text: string) => hooks.get("before_agent_start")({ type: "before_agent_start", messageType: "user", prompt: text }, ctx);
  const request = async (text = "Add search with pagination and account isolation") => {
    await input(text);
    const response = await begin(text);
    const token = response?.message.content.match(/requestId ([a-f0-9-]{36})/)?.[1];
    return { response, token, text };
  };
  return { commands, tools, hooks, shown, notices, prompts, copies, entries, ctx, tool, command, input, begin, request,
    active: () => active };
}
const params = (requestId: string) => ({ requestId, reason: "Keep investigation, changes and verification ordered without losing the requested steps" });
const brief = (text: string) => ({ title: "Search brief", requirements: [{ id: "R1", text, sourceQuote: text }],
  exclusions: [], assumptions: [], risks: [], questions: [], tasks: [], skills: ["wai-node"] });

test("auto-planning defaults on without setup; explicit off persists only on its chat/project branch", async (t) => {
  const root = fixture(t), h = harness(root);
  assert.equal(autoPlanningMode(h.ctx), "on");
  assert.ok((await h.request()).token);
  assert.equal(existsSync(join(root, ".pi")), false);
  await h.command("waicc-auto-planning");
  assert.equal(h.shown.at(-1).autoPlanning, "on");
  assert.equal(h.prompts.length, 0);
  assert.equal(listSessions(root).length, 0);
  await h.command("waicc-auto-planning", "off");
  assert.equal(autoPlanningMode(h.ctx), "off");
  assert.equal((await h.request()).token, undefined);
  await assert.rejects(h.tool("waicc_start_planning", params(randomUUID())), /off/);
  assert.equal(autoPlanningMode(harness(root, [], "other-chat").ctx), "on");
  assert.equal(autoPlanningMode(harness(fixture(t), h.entries).ctx), "on");
  const reloaded = harness(root, h.entries);
  await reloaded.hooks.get("session_start")({}, reloaded.ctx);
  assert.equal(autoPlanningMode(reloaded.ctx), "off");
  assert.equal((await reloaded.request()).token, undefined);
  // Another project's later preference must not hide this project's own setting.
  h.entries.push({ type: "custom", customType: "waicc-auto-planning", data: { projectRoot: fixture(t), mode: "on" } });
  assert.equal(autoPlanningMode(h.ctx), "off");
  h.entries.splice(0); // A branch with no preference uses the new default.
  assert.equal(autoPlanningMode(h.ctx), "on");
});

test("on re-enables planning; legacy complex settings/commands map to on, unknown saved modes fail closed", async (t) => {
  const root = fixture(t), h = harness(root);
  h.entries.push({ type: "custom", customType: "waicc-auto-planning", data: { projectRoot: root, mode: "complex" } });
  assert.equal(autoPlanningMode(h.ctx), "on");
  const reloaded = harness(root, h.entries);
  await reloaded.hooks.get("session_start")({}, reloaded.ctx);
  assert.equal(autoPlanningMode(reloaded.ctx), "on");
  await h.command("waicc-auto-planning", "off");
  await h.command("waicc-auto-planning", "on");
  assert.equal(autoPlanningMode(h.ctx), "on");
  assert.equal(h.entries.at(-1).data.mode, "on");
  assert.ok((await h.request()).token);
  await h.command("waicc-auto-planning", "off");
  await h.command("waicc-auto-planning", "complex");
  assert.equal(autoPlanningMode(h.ctx), "on");
  assert.equal(h.entries.at(-1).data.mode, "on");
  h.entries.push({ type: "custom", customType: "waicc-auto-planning", data: { projectRoot: root, mode: "unsupported" } });
  assert.equal(autoPlanningMode(h.ctx), "off");
  assert.equal((await h.request()).token, undefined);
  await h.command("waicc-auto-planning", "invalid");
  assert.match(h.notices.at(-1)!, /Usage/);
  assert.equal(h.entries.at(-1).data.mode, "unsupported");
});

test("small multi-step work starts planning by default; exact input, retries, brief/context and clipboard keep existing safeguards", async (t) => {
  const root = fixture(t), h = harness(root);
  const req = await h.request("  Rename the setting in config, update its documentation, then check both agree.  ");
  assert.ok(req.token);
  // The extension supplies guidance, not an automatic state mutation/classifier call.
  assert.equal(listSessions(root).length, 0);
  const started = await h.tool("waicc_start_planning", params(req.token));
  const saved = loadSession(root, started.sessionId);
  assert.deepEqual(saved.requirements, [req.text]);
  assert.equal(saved.autoPlanning!.requirementsDigest, digest(req.text));
  assert.equal(saved.autoPlanning!.requestId, req.token);
  assert.equal(saved.objective, "planning");
  assert.equal(saved.status, "DRAFT");
  assert.equal(saved.planApproval, null);
  assert.equal(saved.implementationAuthorization, undefined);
  assert.equal(saved.rounds.length, 0);
  assert.equal(readFileSync(started.requirementsPath, "utf8"), `${req.text}\n`);
  const retry = await h.tool("waicc_start_planning", params(req.token));
  assert.equal(retry.action, "existing_session");
  assert.equal(retry.sessionId, saved.id);
  assert.deepEqual(loadSession(root, saved.id), saved);
  assert.equal(listSessions(root).length, 1);
  assert.equal((await h.hooks.get("tool_call")({ toolName: "edit", input: { path: "app.txt" } }, h.ctx)).block, true);
  await h.tool("waicc_context", { sessionId: saved.id, summary: "Earlier human decision: preserve compatibility with old clients; inspect app.txt." });
  const prepared = await h.tool("waicc_prepare", { sessionId: saved.id, expectedVersion: 0, mode: "planning", focus: "Investigate source and produce the detailed plan", contract: brief(req.text.trim()) });
  assert.equal(prepared.status, "WAITING_FOR_REPLY");
  assert.equal(h.copies.length, 1);
  assert.match(h.copies[0], /HANDOFF\.md/);
  const pending = loadSession(root, saved.id);
  await h.tool("waicc_start_planning", params(req.token));
  assert.deepEqual(loadSession(root, saved.id), pending);
  assert.equal(h.copies.length, 1);
  assert.equal(h.prompts.length, 0);
});

test("selected contracts are returned unchanged for follow-ups; pending scope is never replaced or amended", async (t) => {
  const root = fixture(t), h = harness(root), s = createSession(root, "Existing scope", undefined, "planning");
  prepare(root, s.id, brief("Existing scope"), "planning", "Investigate", 0);
  await h.command("waicc-use", s.id);
  const req = await h.request("Add a different reporting subsystem");
  assert.match(req.response.message.content, /ALREADY selected/);
  const before = loadSession(root, s.id);
  const result = await h.tool("waicc_start_planning", params(req.token));
  assert.equal(result.action, "existing_session");
  assert.equal(result.sessionId, s.id);
  assert.match(result.nextAction, /Unrelated\/ambiguous/);
  assert.deepEqual(loadSession(root, s.id), before);
  assert.equal(listSessions(root).length, 1);
});

test("unbound existing open contracts require human selection, even if only one exists", async (t) => {
  const root = fixture(t), h = harness(root), s = createSession(root, "Existing work");
  const req = await h.request();
  await assert.rejects(h.tool("waicc_start_planning", params(req.token)), /already exist.*waicc-use/);
  assert.equal(listSessions(root).length, 1);
  assert.deepEqual(loadSession(root, s.id), s);
});

test("closed or missing selected contracts stop startup instead of recreating/retargeting", async (t) => {
  for (const deleted of [false, true]) {
    const root = fixture(t), h = harness(root), s = createSession(root, "Previous work");
    await h.command("waicc-use", s.id);
    forceCloseSession(root, s.id);
    if (deleted) deleteSession(root, s.id);
    const req = await h.request();
    if (deleted) {
      assert.match(req.response.message.content, /STOP.*unavailable/);
      assert.equal(req.token, undefined);
    }
    await assert.rejects(h.tool("waicc_start_planning", params(req.token)), deleted ? /No matching live/ : /closed/);
    assert.equal(listSessions(root).length, deleted ? 0 : 1);
  }
});

test("default hooks never create contracts for questions or tiny edits; main-model policy is explicit", async (t) => {
  const root = fixture(t), h = harness(root);
  for (const text of ["What does this module do?", "What is the current status?", "Fix this typo", "Could automatic planning help?"]) {
    const req = await h.request(text);
    assert.match(req.response.message.content, /Trivial one-step edits, explanations, status questions and exploratory discussion need no new contract/);
    await h.hooks.get("agent_end")({}, h.ctx);
  }
  assert.equal(listSessions(root).length, 0);
  assert.equal(h.prompts.length, 0);
});

test("skip marker, slash commands, extension/custom, transformed and streaming inputs cannot supply startup tokens", async (t) => {
  const root = fixture(t), h = harness(root);
  for (const [text, extra] of [
    ["[no-plan] Change a large subsystem", {}], [" /skill:example Add search", {}],
    ["extension generated planning request", { source: "extension" }],
    ["queued work", { streamingBehavior: "followUp" }], ["steered work", { streamingBehavior: "steer" }],
    ["x".repeat(64_001), {}],
  ] as const) {
    await h.input(text, extra);
    assert.equal(await h.begin(text), undefined);
  }
  await h.input("original input");
  assert.equal(await h.begin("transformed input"), undefined);
  await h.input("original input");
  assert.equal(await h.hooks.get("before_agent_start")({ messageType: "custom", message: { content: "planning" } }, h.ctx), undefined);
  await assert.rejects(h.tool("waicc_start_planning", params(randomUUID())), /No matching live/);
  assert.equal(listSessions(root).length, 0);
});

test("stale, wrong-chat, ended, disabled, untrusted and aborted requests cannot start state", async (t) => {
  const root = fixture(t), h = harness(root);
  const first = await h.request(), second = await h.request("Plan account isolation across services");
  await assert.rejects(h.tool("waicc_start_planning", params(first.token)), /No matching live/);
  await assert.rejects(h.tool("waicc_start_planning", { ...params(second.token), reason: " " }), /planning reason/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(h.tool("waicc_start_planning", params(second.token), aborted.signal), /abort/i);
  const other = harness(root, h.entries, "other-chat");
  await assert.rejects(other.tool("waicc_start_planning", params(second.token)), /No matching live/);
  (h.ctx as any).isProjectTrusted = () => false;
  await assert.rejects(h.tool("waicc_start_planning", params(second.token)), /Trust the project/);
  (h.ctx as any).isProjectTrusted = () => true;
  await h.hooks.get("agent_end")({}, h.ctx);
  await assert.rejects(h.tool("waicc_start_planning", params(second.token)), /No matching live/);
  const third = await h.request();
  await h.command("waicc-auto-planning", "off");
  await assert.rejects(h.tool("waicc_start_planning", params(third.token)), /off/);
  assert.equal(listSessions(root).length, 0);
});

test("default-on planning cannot promote recipients or change their tool guards", async (t) => {
  const root = fixture(t), h = harness(root), s = createSession(root, "Existing work", undefined, "planning");
  prepare(root, s.id, brief("Existing work"), "planning", "Investigate", 0);
  await h.command("waicc-receive", s.id);
  const before = loadSession(root, s.id);
  assert.equal((await h.request()).token, undefined);
  assert.equal(h.active().includes("waicc_start_planning"), false);
  await assert.rejects(h.tool("waicc_start_planning", params(randomUUID())), /handoff recipient/);
  await h.command("waicc-auto-planning", "off");
  assert.match(h.notices.at(-1)!, /handoff recipient/);
  assert.equal(autoPlanningMode(h.ctx), "on");
  assert.equal((await h.hooks.get("tool_call")({ toolName: "waicc_start_planning", input: {} }, h.ctx)).block, true);
  assert.deepEqual(loadSession(root, s.id), before);
});

test("human commands and branch navigation supersede startup; disabling or skipping never changes an existing contract", async (t) => {
  const root = fixture(t), h = harness(root);
  const first = await h.request();
  await h.command("waicc-auto-planning");
  await assert.rejects(h.tool("waicc_start_planning", params(first.token)), /No matching live/);
  const second = await h.request();
  await h.hooks.get("session_tree")({}, h.ctx);
  await assert.rejects(h.tool("waicc_start_planning", params(second.token)), /No matching live/);
  const third = await h.request();
  const started = await h.tool("waicc_start_planning", params(third.token));
  const saved = loadSession(root, started.sessionId);
  await h.request("[no-plan] Make changes anyway");
  assert.equal((await h.hooks.get("tool_call")({ toolName: "write", input: { path: "app.txt" } }, h.ctx)).block, true);
  await h.command("waicc-auto-planning", "off");
  assert.deepEqual(loadSession(root, saved.id), saved);
  assert.equal((await h.hooks.get("tool_call")({ toolName: "edit", input: { path: "app.txt" } }, h.ctx)).block, true);
});

test("durable startup origin is atomic/idempotent, detects conflicting scope and never resurrects deleted/closed work", (t) => {
  const root = fixture(t), id = randomUUID();
  const s = createAutoPlanningSession(root, "Add search", "chat", id);
  const retried = createAutoPlanningSession(root, "Add search", "chat", id);
  assert.deepEqual(s, retried);
  assert.throws(() => createAutoPlanningSession(root, "Different scope", "chat", id), /conflicts/);
  assert.equal(listSessions(root).length, 1);
  forceCloseSession(root, s.id);
  assert.throws(() => createAutoPlanningSession(root, "Add search", "chat", id), /closed/);
  deleteSession(root, s.id);
  assert.throws(() => createAutoPlanningSession(root, "Add search", "chat", id), /deleted/);
});

test("writer conflicts cannot create duplicate sessions or overwrite another startup", (t) => {
  const root = fixture(t), id = randomUUID();
  const first = createAutoPlanningSession(root, "Add search", "chat", id);
  writeFileSync(join(root, ".pi/pi-waicc/write.lock"), "another writer");
  assert.throws(() => createAutoPlanningSession(root, "Add search", "chat", id), /locked/);
  assert.deepEqual(loadSession(root, first.id), first);
  assert.equal(listSessions(root).length, 1);
});

test("automatic prompt recovery survives in-run compaction but reload cannot replay an old input token", async (t) => {
  const root = fixture(t), h = harness(root);
  const req = await h.request();
  await h.hooks.get("session_compact")({}, h.ctx);
  const recovered = await h.hooks.get("context")({ messages: [] }, h.ctx);
  assert.ok(recovered.messages[0].content.includes(req.token));
  const started = await h.tool("waicc_start_planning", params(req.token));
  const before = loadSession(root, started.sessionId);
  const reloaded = harness(root, h.entries);
  await reloaded.hooks.get("session_start")({}, reloaded.ctx);
  await assert.rejects(reloaded.tool("waicc_start_planning", params(req.token)), /No matching live/);
  const next = await reloaded.request("Continue the selected plan");
  const resumed = await reloaded.tool("waicc_start_planning", params(next.token));
  assert.equal(resumed.sessionId, started.sessionId);
  assert.equal(resumed.action, "existing_session");
  assert.deepEqual(loadSession(root, started.sessionId), before);
  assert.ok(existsSync(join(root, sessionRelative(started.sessionId), "requirements.md")));
});
