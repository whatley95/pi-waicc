import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";

test("the main agent offers WAICC commands in a picker; the human's pick runs once, as typed", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  const tools = new Map<string, any>(), notices: string[] = [], asked: string[] = [], shown: any[] = [];
  waicc({
    registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool), on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage: (m: any) => shown.push(m), sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const typed: string[] = [];
  const ctx = (pick: (options: string[]) => string | undefined, hasUI = true) => ({
    cwd: root, mode: "tui", hasUI, isIdle: () => false, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "suggest-chat", getBranch: () => [] },
    ui: {
      notify: (m: string) => notices.push(m),
      select: async (title: string, options: string[]) => (asked.push(`${title} ${options.join(" | ")}`), pick(options)),
      setEditorText: (text: string) => typed.push(text),
    },
  }) as unknown as ExtensionToolContext;
  const suggest = (commands: { command: string; why: string }[], context: ExtensionToolContext, question?: string) =>
    tools.get("waicc_suggest_command").execute("call", { commands, question }, undefined, undefined, context);
  const text = (outcome: any) => outcome.content[0].text as string;
  const offered = [
    { command: "/waicc-dispatch --implement", why: "send the fix to your coding agent" },
    { command: " /waicc-list all ", why: "see every session" },
  ];

  // Picked: it runs at once, once, and nothing is left in the input box for a second Enter.
  const ran = await suggest(offered, ctx((options) => options[1]), "Stuck: which session is this?");
  assert.equal(asked.at(-1), "Stuck: which session is this? /waicc-dispatch --implement  ·  send the fix to your coding agent | /waicc-list all  ·  see every session | None of these");
  assert.match(text(ran), /^The human ran \/waicc-list all; its output is shown to them\. End your turn now/);
  assert.equal(shown.length, 1, "the command showed its output once");
  assert.deepEqual(typed, [], "the input box is untouched");

  // A command that fails is reported to the agent too.
  const failed = await suggest(offered, ctx((options) => options[0]));
  assert.match(text(failed), /^The human ran \/waicc-dispatch --implement, and it failed: /);
  assert.equal(notices.at(-1), text(failed).replace(/^The human ran \/waicc-dispatch --implement, and it failed: /, ""), "the human sees the same error");

  // None of these, or Escape: nothing runs.
  const before = shown.length;
  for (const pick of [(options: string[]) => options.at(-1), () => undefined])
    assert.match(text(await suggest(offered, ctx(pick))), /chose none of these/);
  assert.equal(shown.length, before);
  assert.match(asked.at(-1)!, /^The agent suggests running a WAICC command /);

  // Only real WAICC commands, one line each; no picker without UI.
  const pickers = asked.length;
  await assert.rejects(suggest([{ command: "/reload", why: "x" }], ctx(() => undefined)), /"\/reload" is not a WAICC command\. Only these can be offered: .*\/waicc-worktree/);
  await assert.rejects(suggest([{ command: "waicc-status", why: "x" }], ctx(() => undefined)), /is not a WAICC command/);
  await assert.rejects(suggest([{ command: "/waicc-status\n/waicc-close done", why: "x" }], ctx(() => undefined)), /one command line/);
  await assert.rejects(suggest(offered, ctx(() => undefined, false)), /No picker here\. Write the commands in your reply for the human to type: \/waicc-dispatch --implement, \/waicc-list all/);
  assert.equal(asked.length, pickers);
});
