import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";

test("the main agent offers WAICC commands in a picker; the pick waits in the input box for the human", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  const tools = new Map<string, any>(), notices: string[] = [], asked: string[] = [];
  waicc({
    registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool), on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  let editor = "";
  const ctx = (pick: (options: string[]) => string | undefined, hasUI = true) => ({
    cwd: root, mode: "tui", hasUI, isIdle: () => false, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "suggest-chat", getBranch: () => [] },
    ui: {
      notify: (m: string) => notices.push(m),
      select: async (title: string, options: string[]) => (asked.push(`${title} ${options.join(" | ")}`), pick(options)),
      getEditorText: () => editor,
      setEditorText: (text: string) => { editor = text; },
    },
  }) as unknown as ExtensionToolContext;
  const suggest = (commands: { command: string; why: string }[], context: ExtensionToolContext, question?: string) =>
    tools.get("waicc_suggest_command").execute("call", { commands, question }, undefined, undefined, context);
  const text = (outcome: any) => outcome.content[0].text as string;
  const offered = [
    { command: "/waicc-worktree list", why: "see which branch folders you have" },
    { command: " /waicc-dispatch --implement ", why: "send the fix to your coding agent" },
  ];

  // Picked: in the input box, not run, and the agent is told to stop.
  const picked = await suggest(offered, ctx((options) => options[1]), "Stuck: the branch folder is missing");
  assert.equal(asked.at(-1), "Stuck: the branch folder is missing /waicc-worktree list  ·  see which branch folders you have | /waicc-dispatch --implement  ·  send the fix to your coding agent | None of these");
  assert.equal(editor, "/waicc-dispatch --implement");
  assert.match(text(picked), /chose \/waicc-dispatch --implement\. It is in their input box .* it has not run yet\. End your turn/);

  // Unsent text is kept; the human is told the command instead.
  editor = "my own note";
  const kept = await suggest(offered, ctx((options) => options[0]));
  assert.equal(editor, "my own note");
  assert.match(notices.at(-1)!, /^Type \/waicc-worktree list when you are ready; your unsent text was kept\./);
  assert.match(text(kept), /not put in their input box/);

  // None of these, or Escape: nothing changes.
  editor = "";
  for (const pick of [(options: string[]) => options.at(-1), () => undefined]) {
    assert.match(text(await suggest(offered, ctx(pick))), /chose none of these/);
    assert.equal(editor, "");
  }
  assert.match(asked.at(-1)!, /^The agent suggests running a WAICC command /);

  // Only real WAICC commands, one line each; no picker without UI.
  const before = asked.length;
  await assert.rejects(suggest([{ command: "/reload", why: "x" }], ctx(() => undefined)), /"\/reload" is not a WAICC command\. Only these can be offered: .*\/waicc-worktree/);
  await assert.rejects(suggest([{ command: "waicc-status", why: "x" }], ctx(() => undefined)), /is not a WAICC command/);
  await assert.rejects(suggest([{ command: "/waicc-status\n/waicc-close done", why: "x" }], ctx(() => undefined)), /one command line/);
  await assert.rejects(suggest(offered, ctx(() => undefined, false)), /No picker here\. Write the commands in your reply for the human to type: \/waicc-worktree list, \/waicc-dispatch --implement/);
  assert.equal(asked.length, before);
});
