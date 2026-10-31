import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { errorLogLimit, readErrors, recordError } from "../src/error-log.ts";
import { initialize, runtimePath } from "../src/files.ts";
import { loggingContext } from "../src/pi/app.ts";

function folder(t: TestContext, waiccProject = true) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  if (waiccProject) initialize(root);
  return root;
}

test("errors are kept in the project's WAICC folder, never create one, and stay small", (t) => {
  const plain = folder(t, false);
  recordError(plain, "/waicc-status", "boom");
  assert.equal(existsSync(join(plain, runtimePath)), false, "a folder that does not use WAICC gets nothing");

  const root = folder(t);
  recordError(root, "/waicc-amend", "Requirement amendment must be nonempty text (maximum 32000 characters)");
  const [entry] = readErrors(root);
  assert.equal(entry.source, "/waicc-amend");
  assert.match(entry.message, /^Requirement amendment must be nonempty text/);
  assert.ok(!Number.isNaN(Date.parse(entry.at)));

  for (let i = 0; i < 200; i++) recordError(root, "loop", `failure ${i} ${"x".repeat(1_900)}`);
  const path = join(root, runtimePath, "errors.jsonl");
  assert.ok(statSync(path).size <= errorLogLimit, "the oldest half goes once it is too big");
  assert.match(readErrors(root).at(-1)!.message, /^failure 199 /, "the newest stay");
  writeFileSync(path, `not json\n${JSON.stringify({ at: "t", source: "s", message: "m" })}\n`);
  assert.deepEqual(readErrors(root).map((e) => e.message), ["m"], "a damaged line is skipped");
});

test("a Pi command's error, and a warning shown later on its context, go to the log; info does not", async (t) => {
  const root = folder(t);
  const commands = new Map<string, any>(), notices: string[] = [];
  waicc({
    registerCommand: (name: string, c: any) => commands.set(name, c), registerTool() {}, on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  let trusted = true;
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "log-chat", getBranch: () => [] },
    ui: { notify: (m: string) => notices.push(m), setWidget() {}, setStatus() {} },
  } as unknown as ExtensionCommandContext;
  await commands.get("waicc-reopen").handler("Needed after all", ctx);
  assert.match(notices.at(-1)!, /^No WAICC session selected/, "the human still sees it");
  assert.deepEqual(readErrors(root).map((e) => [e.source, e.message.slice(0, 26)]), [["/waicc-reopen", "No WAICC session selected."]]);

  const later = loggingContext(ctx, "dispatch");
  later.ui.notify("codex has shown no new step for 10 minutes", "warning");
  later.ui.notify("codex submitted a reply.", "info");
  assert.deepEqual(readErrors(root).map((e) => e.source), ["/waicc-reopen", "dispatch"]);
  assert.equal(loggingContext(later, "other"), later, "wrapped once");
  trusted = false;
  later.ui.notify("untrusted", "error");
  assert.equal(readErrors(root).length, 2, "nothing is written into a project you have not trusted");
});

test("the logging context keeps Pi's getters live and its other methods working", () => {
  let cwd = "first";
  const ctx = { get cwd() { return cwd; }, isProjectTrusted: () => false, ui: { notify() {}, confirm: async () => true } } as unknown as ExtensionCommandContext;
  const logged = loggingContext(ctx, "x");
  cwd = "second";
  assert.equal(logged.cwd, "second", "read when used, not copied once");
  assert.equal(typeof logged.ui.confirm, "function");
});

test("a failed CLI command is logged in its project", (t) => {
  const root = folder(t);
  const cli = spawnSync(process.execPath, [resolve("src/cli.ts"), "--root", root, "continue", "00000000-0000-4000-8000-000000000000"], { encoding: "utf8", windowsHide: true });
  assert.equal(cli.status, 1);
  const [entry] = readErrors(root);
  assert.equal(entry.source, "waicc continue");
  assert.equal(entry.message, cli.stderr.trim());
});
