import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { createSession } from "../src/workflow.ts";
import { terminalCommand, type TerminalOptions } from "../src/pi/worktrees.ts";

const id = "0a1b2c3d-1111-4222-8333-444455556666";

test("a new terminal is a Windows Terminal tab or window running Pi, with the handed-over session set for it", () => {
  const wt = "C:/wt.exe";
  assert.deepEqual(terminalCommand("C:/app", { place: "tab", handover: id }, wt),
    [wt, ["-w", "0", "nt", "-d", "C:/app", "powershell", "-NoExit", "-Command", `$env:WAICC_HANDOVER='${id}'\\; pi`]]);
  assert.deepEqual(terminalCommand("C:/app", { place: "window", handover: id }, wt)[1].slice(0, 2), ["-w", "new"]);
  // As before for a branch folder: as Windows Terminal is set up, and only Pi.
  assert.deepEqual(terminalCommand("C:/app", {}, wt), [wt, ["-d", "C:/app", "powershell", "-NoExit", "-Command", "pi"]]);
  // Without Windows Terminal, a PowerShell window, where ";" needs no escape.
  assert.deepEqual(terminalCommand("C:/app", { place: "tab", handover: id }, null),
    ["cmd.exe", ["/c", "start", "", "/D", "C:/app", "powershell", "-NoExit", "-Command", `$env:WAICC_HANDOVER='${id}'; pi`]]);
  assert.throws(() => terminalCommand("C:/app", { handover: "x'; rm -r ." }, wt), /Not a session ID/);
});

function harness(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "app.txt"), "app");
  const session = createSession(root, "Add a menu");
  const commands = new Map<string, any>(), handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>();
  const shown: string[] = [], notices: string[] = [], entries: { chat: string; data: any }[] = [], opened: [string, TerminalOptions | undefined][] = [];
  let chat = "old-chat";
  const ctx = (id: string) => ({
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => id, getBranch: () => entries.filter((e) => e.chat === id).map((e) => ({ type: "custom", customType: "waicc-session", data: e.data })), getEntries: () => [] },
    ui: { notify: (m: string) => notices.push(m), setWidget() {}, setStatus() {} },
    waitForIdle: async () => {},
    newSession: async (options: { withSession?: (next: unknown) => Promise<void> }) => {
      chat = "new-chat";
      await options.withSession?.(ctx("new-chat"));
      return { cancelled: false };
    },
  });
  waicc({
    registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {},
    on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (_type: string, data: unknown) => entries.push({ chat, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
    sendMessage: (m: { content: string }) => shown.push(m.content), sendUserMessage() {},
  } as unknown as ExtensionAPI, { openTerminal: (path, options) => (opened.push([path, options]), true) });
  const start = async (id: string) => { for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, ctx(id)); };
  return { root, session, commands, shown, notices, entries, opened, ctx, start, chat: () => chat };
}

test("/waicc-handover starts a new chat here with the session selected; the old chat keeps it in /resume", async (t) => {
  const h = harness(t);
  await h.commands.get("waicc-use").handler(h.session.id, h.ctx("old-chat"));
  await h.commands.get("waicc-handover").handler("", h.ctx("old-chat"));
  assert.equal(h.chat(), "new-chat");
  assert.deepEqual(h.entries.filter((e) => e.chat === "new-chat").map((e) => e.data.sessionId), [h.session.id], "selected in the new chat");
  assert.equal(JSON.parse(h.shown.at(-1)!).sessionId, h.session.id, "its status is shown there");
  assert.equal(h.notices.at(-1), `This new chat carries session ${h.session.id}; the previous chat stays in /resume.`);
  await h.commands.get("waicc-handover").handler("--nope", h.ctx("new-chat"));
  assert.match(h.notices.at(-1)!, /^Usage: \/waicc-handover \[session-id\] \[--tab\|--window\]$/);
});

test("/waicc-handover --tab opens Pi in a new terminal, which selects the session as it starts", async (t) => {
  const h = harness(t);
  await h.commands.get("waicc-use").handler(h.session.id, h.ctx("old-chat"));
  await h.commands.get("waicc-handover").handler("--tab", h.ctx("old-chat"));
  if (process.platform !== "win32") {
    assert.match(h.notices.at(-1)!, /^A new tab or window opens on Windows only/);
    return;
  }
  assert.deepEqual(h.opened, [[h.root, { place: "tab", handover: h.session.id }]]);
  assert.equal(h.notices.at(-1), `Opened a new tab running Pi with session ${h.session.id} selected. You can close this one.`);

  // The new Pi: its first chat selects the session, and only that chat.
  const fresh = harness(t);
  process.env.WAICC_HANDOVER = fresh.session.id;
  t.after(() => delete process.env.WAICC_HANDOVER);
  await fresh.start("first-chat");
  assert.equal(process.env.WAICC_HANDOVER, undefined, "used once");
  assert.deepEqual(fresh.entries.map((e) => e.data.sessionId), [fresh.session.id]);
  assert.ok(fresh.notices.includes(`This window carries session ${fresh.session.id}, handed over from another chat.`), fresh.notices.join("\n"));
});
