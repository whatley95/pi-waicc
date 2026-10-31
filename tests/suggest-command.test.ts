import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import type { AgentRunner } from "../src/dispatch.ts";
import { createSession, ingest, prepare } from "../src/workflow.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import type { Contract } from "../src/types.ts";

test("the main agent offers WAICC commands in a picker that opens after its turn; the human's pick runs once, as typed", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  const tools = new Map<string, any>(), handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<void>)[]>();
  const notices: string[] = [], asked: string[] = [], shown: any[] = [];
  waicc({
    registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool), appendEntry() {},
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage: (m: any) => shown.push(m), sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const emit = async (event: string, context: unknown) => { for (const handler of handlers.get(event) ?? []) await handler({ type: event }, context); };
  const typed: string[] = [];
  // The picker answers when the test says so, like a human who may take their time.
  let answer: ((options: string[]) => string | undefined) | undefined, open: { options: string[]; resolve: (value: string | undefined) => void; signal?: AbortSignal } | undefined;
  const ctx = (hasUI = true) => ({
    cwd: root, mode: "tui", hasUI, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "suggest-chat", getBranch: () => [], getEntries: () => [] },
    ui: {
      notify: (m: string) => notices.push(m), setStatus() {}, setWidget() {},
      select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => new Promise<string | undefined>((resolve) => {
        asked.push(`${title} ${options.join(" | ")}`);
        open = { options, resolve, signal: opts?.signal };
        opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        if (answer) resolve(answer(options));
      }),
      setEditorText: (text: string) => typed.push(text),
    },
  }) as unknown as ExtensionToolContext;
  const suggest = (commands: { command: string; why: string }[], context: ExtensionToolContext, question?: string) =>
    tools.get("waicc_suggest_command").execute("call", { commands, question }, undefined, undefined, context);
  const text = (outcome: any) => outcome.content[0].text as string;
  // A picked command first lets Pi draw its running line (25 ms), then runs. With a check, wait until it holds
  // (a loaded machine can take longer), otherwise 150 ms.
  const settle = async (check?: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (check ? check() : i >= 14) return;
    }
  };
  const offered = [
    { command: "/waicc-dispatch --implement", why: "send the fix to your coding agent" },
    { command: " /waicc-list all ", why: "see every session" },
  ];
  const chat = ctx();

  // The tool returns at once: nothing waits on the human during the agent's turn.
  answer = undefined;
  const result = await suggest(offered, chat, "Stuck: which session is this?");
  assert.match(text(result), /^Offered to the human in a picker that opens when your turn ends: \/waicc-dispatch --implement, \/waicc-list all\. End your turn now/);
  assert.equal(asked.length, 0, "no picker during the turn");
  // The turn ends; the picker opens, once later turn-end work has run, and may stay open as long as the human likes.
  await emit("agent_end", chat);
  await settle(() => asked.length === 1);
  assert.equal(asked.at(-1), "Stuck: which session is this? /waicc-dispatch --implement  ·  send the fix to your coding agent | /waicc-list all  ·  see every session | None of these");
  await emit("agent_end", chat);
  assert.equal(asked.length, 1, "one picker per offer");
  open!.resolve(open!.options[1]);
  await settle(() => shown.length > 0);
  assert.equal(shown.length, 1, "the picked command showed its output once");
  assert.deepEqual(typed, [], "the input box is untouched");
  await emit("agent_end", chat);
  assert.equal(asked.length, 1, "an answered offer is not shown again");

  // A command that fails shows its error to the human.
  answer = (options) => options[0];
  const notified = notices.length;
  await suggest(offered, chat);
  await emit("agent_end", chat);
  await settle();
  assert.match(notices.slice(notified).join("\n"), /session/i, "the human sees why /waicc-dispatch failed");
  assert.match(asked.at(-1)!, /^The agent suggests running a WAICC command /);

  // None of these, or Escape: nothing runs.
  const before = shown.length;
  for (const pick of [(options: string[]) => options.at(-1), () => undefined]) {
    answer = pick;
    await suggest(offered, chat);
    await emit("agent_end", chat);
    await settle();
  }
  assert.equal(shown.length, before);

  // When the agent starts again, an open picker is withdrawn and nothing runs.
  answer = undefined;
  await suggest(offered, chat);
  await emit("agent_end", chat);
  await settle();
  const pending = open!;
  await emit("agent_start", chat);
  assert.ok(pending.signal?.aborted, "the open picker was withdrawn");
  pending.resolve(pending.options[1]);
  await settle();
  assert.equal(shown.length, before);
  await emit("agent_end", chat);
  assert.equal(open, pending, "a withdrawn offer is not shown again");

  // A command that needs the human's text is not run bare: picking it fills the input box to finish.
  answer = (options) => options[0];
  const bare = await suggest([{ command: "/waicc-amend", why: "record the change of scope" }], chat);
  assert.match(text(bare), /\/waicc-amend needs text you did not give, so picking it only puts it in the human's input box to finish/);
  const ran = shown.length;
  await emit("agent_end", chat);
  await settle(() => typed.length > 0);
  assert.match(asked.at(-1)!, /\/waicc-amend …  ·  record the change of scope \(you add the text\)/);
  assert.deepEqual(typed, ["/waicc-amend "]);
  assert.match(notices.at(-1)!, /^\/waicc-amend needs your text: finish it in the input box, then press Enter\.$/);
  assert.equal(shown.length, ran, "nothing ran");

  // Only real WAICC commands, one line each; no picker without UI.
  await assert.rejects(suggest([{ command: "/reload", why: "x" }], chat), /"\/reload" is not a WAICC command\. Only these can be offered: .*\/waicc-worktree/);
  await assert.rejects(suggest([{ command: "waicc-status", why: "x" }], chat), /is not a WAICC command/);
  await assert.rejects(suggest([{ command: "/waicc-status\n/waicc-close done", why: "x" }], chat), /one command line/);
  await assert.rejects(suggest(offered, ctx(false)), /No picker here\. Write the commands in your reply for the human to type: \/waicc-dispatch --implement, \/waicc-list all/);
});

test("every WAICC command shows a running line before its work starts and clears it after, even when it fails", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const commands = new Map<string, any>(), events: string[] = [];
  waicc({
    registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {}, on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage: () => events.push("output"), sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "busy-chat", getBranch: () => [], getEntries: () => [] },
    ui: {
      notify: (m: string) => events.push(`notice ${m.slice(0, 20)}`), setStatus() {},
      setWidget: (key: string, lines: string[] | undefined) => { if (key === "waicc-busy") events.push(lines ? lines.join() : "cleared"); },
    },
  };
  await commands.get("waicc-list").handler("all", ctx);
  assert.deepEqual(events, ["⏳ WAICC: running /waicc-list…", "output", "cleared"]);
  events.length = 0;
  await commands.get("waicc-dispatch").handler("", ctx);
  assert.equal(events[0], "⏳ WAICC: running /waicc-dispatch…");
  assert.match(events[1], /^notice /, "the failure is shown");
  assert.equal(events.at(-1), "cleared");
  // An RPC client gets the line too; with no UI there is none, and a UI without widgets still runs the command.
  events.length = 0;
  await commands.get("waicc-list").handler("all", { ...ctx, mode: "rpc" });
  assert.deepEqual(events, ["⏳ WAICC: running /waicc-list…", "output", "cleared"]);
  events.length = 0;
  await commands.get("waicc-list").handler("all", { ...ctx, mode: "print", hasUI: false });
  await commands.get("waicc-list").handler("all", { ...ctx, ui: { notify() {}, setStatus() {} } });
  assert.deepEqual(events, ["output", "output"]);
});

test("while a dispatch runs for the session, the picker leaves out dispatch starts, and a late pick starts nothing", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan: Contract = { title: "Search", requirements: [{ id: "R1", text: "Search", sourceQuote: "Add search" }],
    exclusions: [], assumptions: [], questions: [], risks: [], skills: [], tasks: [] };
  const s = createSession(root, "Add search", undefined, "planning");
  prepare(root, s.id, plan, "planning", "Plan", 0);
  // The planner works until the test lets it finish, like a loop's next cycle.
  let finish = () => {};
  const planner: AgentRunner = () => new Promise((resolve) => { finish = () => resolve({ stdout: "", stderr: "", code: 0, killed: false }); });
  const tools = new Map<string, any>(), commands = new Map<string, any>(), handlers = new Map<string, any[]>();
  const notices: string[] = [], asked: string[][] = [];
  waicc({
    registerCommand: (name: string, c: any) => commands.set(name, c), registerTool: (tool: any) => tools.set(tool.name, tool), appendEntry() {},
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI, { runAgent: planner });
  let pick: (options: string[]) => string | undefined = () => undefined, resolveOpen: (() => void) | undefined;
  const chat = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "busy-chat", getBranch: () => [], getEntries: () => [] },
    ui: {
      notify: (m: string) => notices.push(m), setStatus() {}, setWidget() {},
      select: (_title: string, options: string[]) => new Promise<string | undefined>((resolve) => { asked.push(options); resolveOpen = () => resolve(pick(options)); }),
    },
  } as unknown as ExtensionCommandContext;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const endTurn = async () => { for (const handler of handlers.get("agent_end") ?? []) await handler({ type: "agent_end" }, chat); await settle(); };
  const offer = (commands: string[]) => tools.get("waicc_suggest_command").execute("call", { commands: commands.map((command) => ({ command, why: "next" })) }, undefined, undefined, chat);
  await commands.get("waicc-use").handler(s.id, chat);

  // Offered before the run starts, picked after it started: nothing else is started.
  await offer(["/waicc-dispatch --via claude", "/waicc-status"]);
  await endTurn();
  assert.deepEqual(asked.at(-1)!.map((o) => o.split("  ·")[0]), ["/waicc-dispatch --via claude", "/waicc-status", "None of these"]);
  await commands.get("waicc-dispatch").handler("--via claude", chat);
  pick = (options) => options[0];
  resolveOpen!();
  await settle();
  assert.match(notices.at(-1)!, /^Already running: WAICC · claude[^.]*\. Nothing else was started; \/waicc-dispatch --progress shows its steps\.$/);

  // Offered while it runs: dispatch starts are left out; --progress and other commands stay.
  await offer(["/waicc-dispatch --continue", "/waicc-dispatch --progress", "/waicc-status"]);
  await endTurn();
  assert.deepEqual(asked.at(-1)!.map((o) => o.split("  ·")[0]), ["/waicc-dispatch --progress", "/waicc-status", "None of these"]);
  pick = () => undefined;
  resolveOpen!();
  // Only a dispatch start offered: no picker at all.
  const pickers = asked.length;
  await offer(["/waicc-dispatch --loop"]);
  await endTurn();
  assert.equal(asked.length, pickers);

  // A decision while its handoff is being worked on: nothing to pick yet, and the human is told why.
  await offer(["/waicc-develop"]);
  await endTurn();
  assert.equal(asked.length, pickers);
  assert.match(notices.at(-1)!, /^A planning handoff is being worked on \(WAICC · claude[^)]*\), so \/waicc-develop cannot run until its reply is assessed\.$/);
  finish();
  await settle();

  // Still waiting, with no agent on it: the decision gives way to sending the handoff.
  await offer(["/waicc-develop", "/waicc-status"]);
  await endTurn();
  assert.deepEqual(asked.at(-1)!.map((o) => o.split("  ·")[0]), ["/waicc-dispatch", "/waicc-status", "None of these"]);
  pick = () => undefined;
  resolveOpen!();

  // Its reply arrived but is not assessed: the decision gives way to /waicc-continue.
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, { outcome: "planned", summary: "Plan", findings: [], questions: [],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "source" }], checks: [{ description: "Read", outcome: "passed", evidence: "Inspected" }] });
  ingest(root, s.id);
  await offer(["/waicc-decide D1 keep it", "/waicc-help-develop --main Build it"]);
  await endTurn();
  assert.deepEqual(asked.at(-1)!.map((o) => o.split("  ·")[0]), ["/waicc-continue", "/waicc-help-develop --main Build it", "None of these"], "coding it yourself needs no handoff, so it stays");
  pick = () => undefined;
  resolveOpen!();
  await settle();
});
