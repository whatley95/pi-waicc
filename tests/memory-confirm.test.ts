import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { memoryStates, propose } from "../src/memory.ts";

test("/waicc-memory confirm and revoke work without IDs: pick from a list, or all after one dialog", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "theme.ts"), "framework-native");
  writeFileSync(join(root, "fonts.ts"), "API 21 guard");
  writeFileSync(join(root, "old.ts"), "before");
  const policy = propose(root, "Use the framework-native theme policy", "theme.ts", "decision");
  const guard = propose(root, "Guard custom fonts on API 21", "fonts.ts", "lesson");
  propose(root, "A lesson whose source then changed", "old.ts", "lesson");
  writeFileSync(join(root, "old.ts"), "after");

  const commands = new Map<string, any>(), shown: any[] = [], notices: string[] = [], asked: string[] = [];
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool() {}, on() {},
    appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
    sendMessage: (m: any) => { if (m.customType !== "waicc-status-table") shown.push(JSON.parse(m.content)); }, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const base = {
    cwd: root, mode: "tui", isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "memory-chat", getBranch: () => [] },
  };
  const plain = { ...base, hasUI: false, ui: { notify: (m: string) => notices.push(m) } } as unknown as ExtensionCommandContext;
  const dialog = (pick: (options: string[]) => string | undefined, agree = true) => ({ ...base, hasUI: true, ui: {
    notify: (m: string) => notices.push(m),
    select: async (title: string, options: string[]) => (asked.push(`${title} ${options.join(" | ")}`), pick(options)),
    confirm: async (title: string, message: string) => (asked.push(`${title}\n${message}`), agree),
  } }) as unknown as ExtensionCommandContext;
  const state = (id: string) => memoryStates(root).find((entry) => entry.id === id)!.state;
  const memory = (args: string, ctx: ExtensionCommandContext) => commands.get("waicc-memory").handler(args, ctx);

  // The reported error: no ID typed. Now it lists the candidates instead.
  await memory("confirm", plain);
  assert.match(notices.at(-1)!, new RegExp(`^Usage: /waicc-memory confirm <id>\\|all\\. Candidates: ${policy.id} decision: Use the framework-native theme policy \\(from theme\\.ts\\); ${guard.id} lesson`));
  assert.match(notices.at(-1)!, /1 stale candidate cannot be confirmed: its source changed/);
  await memory("confirm nope", plain);
  assert.match(notices.at(-1)!, /^Unknown memory ID "nope"\. Candidates:/);

  // Pick one from the list; stale candidates are not offered.
  await memory("confirm", dialog((options) => options.find((option) => option.includes("API 21"))));
  assert.match(asked.at(-1)!, /^Which entry do you want to confirm\? .* \| All 2 of them$/);
  assert.equal(state(guard.id), "active");
  assert.equal(state(policy.id), "candidate");

  // all: one dialog listing every candidate; declining changes nothing.
  propose(root, "Another candidate", "theme.ts", "fact");
  await memory("confirm all", dialog(() => undefined, false));
  assert.match(asked.at(-1)!, /^Confirm all 2\?\n• decision: Use the framework-native theme policy/);
  assert.match(asked.at(-1)!, /goes into every future handoff/);
  assert.equal(state(policy.id), "candidate");
  await memory("confirm all", dialog(() => undefined, true));
  assert.equal(memoryStates(root).filter((entry) => entry.state === "candidate").length, 0);

  // Revoke works the same way.
  await memory("revoke", dialog((options) => options.find((option) => option.includes("framework-native"))));
  assert.equal(state(policy.id), "revoked");
});
