import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";

test("several questions in one picker: after each answer the picker comes back with the rest", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  const tools = new Map<string, any>(), typedCommands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<void>)[]>();
  const asked: string[] = [], typed: string[] = [];
  let idle = true;
  waicc({
    registerCommand: (name: string, options: any) => typedCommands.set(name, options.handler),
    registerTool: (tool: any) => tools.set(tool.name, tool), appendEntry() {},
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const emit = async (event: string, context: unknown) => { for (const handler of handlers.get(event) ?? []) await handler({ type: event }, context); };
  let open: { options: string[]; resolve: (value: string | undefined) => void } | undefined;
  const chat = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => idle, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "reoffer-chat", getBranch: () => [], getEntries: () => [] },
    ui: {
      notify() {}, setStatus() {}, setWidget() {},
      select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => new Promise<string | undefined>((resolve) => {
        asked.push(`${title}: ${options.map((o) => o.split("  ·  ")[0]).join(" | ")}`);
        open = { options, resolve };
        opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      }),
      setEditorText: (text: string) => typed.push(text),
    },
  } as unknown as ExtensionToolContext;
  const suggest = (each: boolean | undefined) => tools.get("waicc_suggest_command").execute("call", {
    question: "Three things only you can answer",
    each,
    commands: [
      { command: "/waicc-list all", why: "which session" },
      { command: "/waicc-amend", why: "what changes" },
      { command: "/waicc-status", why: "where it stands" },
    ],
  }, undefined, undefined, chat);
  const settle = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const pick = (command: string) => open!.resolve(open!.options.find((o) => o.startsWith(command)));

  await suggest(true);
  await emit("agent_end", chat);
  await settle(() => asked.length === 1);
  assert.equal(asked[0], "Three things only you can answer: /waicc-list all | /waicc-amend … | /waicc-status | None of these");
  // A command that runs at once: the picker returns with the other two.
  pick("/waicc-list all");
  await settle(() => asked.length === 2);
  assert.equal(asked[1], "Three things only you can answer: /waicc-amend … | /waicc-status | None of these");
  // One that needs the human's text waits in the input box; the last question comes back once the human has run it.
  pick("/waicc-amend");
  await settle(() => typed.length === 1);
  assert.deepEqual(typed, ["/waicc-amend "]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(asked.length, 2, "nothing comes back while the human is still typing");
  await typedCommands.get("waicc-status")!("", chat);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(asked.length, 2, "another command is not the answer it waits for");
  await typedCommands.get("waicc-amend")!("the search also covers archived customers", chat);
  await settle(() => asked.length === 3);
  assert.equal(asked[2], "Three things only you can answer: /waicc-status | None of these");
  // None of these ends it.
  pick("None of these");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(asked.length, 3);

  // A command that starts the agent leaves the rest to its new turn.
  await suggest(true);
  await emit("agent_end", chat);
  await settle(() => asked.length === 4);
  idle = false;
  pick("/waicc-list all");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(asked.length, 4, "the agent is working: it decides what to offer next");
  idle = true;

  // A message to the agent drops the rest too.
  await suggest(true);
  await emit("agent_end", chat);
  await settle(() => asked.length === 5);
  pick("/waicc-amend");
  await settle(() => typed.length === 2);
  await emit("agent_start", chat);
  await typedCommands.get("waicc-amend")!("later", chat);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(asked.length, 5);

  // Alternatives (each not set): one pick settles it.
  await suggest(undefined);
  await emit("agent_end", chat);
  await settle(() => asked.length === 6);
  pick("/waicc-list all");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(asked.length, 6, "the other alternatives do not come back");
});
