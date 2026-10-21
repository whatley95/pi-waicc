import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { agyServerName, registerAgyServer, removeStaleAgyServers, unregisterAgyServer, type AgyRunner } from "../src/agy.ts";
import { progressParser } from "../src/progress.ts";
import { usageMeter } from "../src/usage.ts";

// Lines as agy 1.4 streams them (shortened from a real run).
const step = (step_update: object) => JSON.stringify({ event: "step_update", step_update: { conversation_id: "c", ...step_update } });
const run = [
  JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-medium", tools: ["call_mcp_tool", "read_file"], permission_mode: "request-review" } }),
  step({ step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 2838, output_tokens: 185, thinking_tokens: 40, cache_read_tokens: 31451, total_tokens: 3023 } }),
  step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool", parameters: { ServerName: "waicc-run-1", ToolName: "waicc_receive", Arguments: {} } } }),
  step({ step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "read_file", tool_info: { name: "read_file", parameters: { Path: "/work/app/src/greet.js" } } }),
  step({ step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } } }),
  step({ step_index: 4, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "npm test" }, error: "denied" } }),
  step({ step_index: 5, state: "ACTIVE", step_type: "agent_response", text_delta: "Reply " }),
  step({ step_index: 5, state: "DONE", step_type: "agent_response", text_delta: "submitted.", usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 5, cache_read_tokens: 900, total_tokens: 110 } }),
  JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 155291, output_tokens: 12426, thinking_tokens: 7649, cache_read_tokens: 573022, total_tokens: 167717 } } }),
];

test("agy's step stream reads as WAICC steps: its tools, WAICC's MCP tools, and its reply", () => {
  const parse = progressParser("agy", "/work/app");
  const events = run.flatMap((line) => parse(line));
  assert.deepEqual(events.map((e) => [e.kind, e.text]), [
    ["waicc", "Received the assignment"],
    ["step", "Reading src/greet.js"],
    ["step", "Running npm test"],
    ["note", "Reply submitted."],
  ]);
});

test("agy's usage: cache reads are input on top of input_tokens, thinking is output, and no price", () => {
  const meter = usageMeter("agy");
  for (const line of run.slice(0, 2)) meter.read(line);
  assert.deepEqual(meter.get(), { inputTokens: 2838 + 31451, cachedTokens: 31451, outputTokens: 225, costUsd: null }, "steps count while it runs");
  for (const line of run.slice(2)) meter.read(line);
  assert.deepEqual(meter.get(), { inputTokens: 155291 + 573022, cachedTokens: 573022, outputTokens: 12426 + 7649, costUsd: null }, "the result's total replaces them");
});

function settings(t: TestContext, content?: object | string) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  const path = join(base, "settings.json");
  if (content !== undefined) writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("each agy run registers its pinned server and allows exactly WAICC's tools on it, then removes both", (t) => {
  const path = settings(t, { model: "gemini", trustedWorkspaces: ["C:/work"], permissions: { allow: ["mcp(chrome_devtools/*)"], deny: ["command(rm)"] } });
  const calls: string[][] = [];
  const agy: AgyRunner = (args) => (calls.push(args), "");
  const name = agyServerName("670a33b8-6c7b-4063", new Date("2026-10-21T11:25:00Z"));
  assert.equal(name, "waicc-run-202610211125-670a33b8");
  registerAgyServer({ name, command: "node", args: ["cli.ts", "mcp", "--session", "s", "--request", "r"] }, ["waicc_receive", "waicc_submit_reply"], agy, path);
  assert.deepEqual(calls.at(-1), ["mcp", "add", name, "--", "node", "cli.ts", "mcp", "--session", "s", "--request", "r"]);
  const during = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(during.permissions.allow, ["mcp(chrome_devtools/*)", `mcp(${name}/waicc_receive)`, `mcp(${name}/waicc_submit_reply)`]);
  assert.deepEqual([during.model, during.trustedWorkspaces, during.permissions.deny], ["gemini", ["C:/work"], ["command(rm)"]], "everything else is kept");

  unregisterAgyServer(name, agy, path);
  assert.deepEqual(calls.at(-1), ["mcp", "remove", name]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).permissions, { allow: ["mcp(chrome_devtools/*)"], deny: ["command(rm)"] });
});

test("what a crashed run left is removed after three hours; agy settings that are not JSON stop the dispatch untouched", (t) => {
  const path = settings(t, { permissions: { allow: ["mcp(waicc-run-202610210800-aaaaaaaa/waicc_receive)", "mcp(waicc-run-202610211100-bbbbbbbb/waicc_receive)", "mcp(other/x)"] } });
  const calls: string[][] = [];
  const agy: AgyRunner = (args) => (calls.push(args), args[1] === "list"
    ? "NAME TYPE STATUS COMMAND/URL\nwaicc-run-202610210800-aaaaaaaa stdio enabled node cli.ts\nwaicc-run-202610211100-bbbbbbbb stdio enabled node cli.ts\n"
    : "");
  const removed = removeStaleAgyServers(agy, path, Date.parse("2026-10-21T11:30:00Z"));
  assert.deepEqual(removed, ["waicc-run-202610210800-aaaaaaaa"], "a run from 3.5 hours ago; the one from 30 minutes ago may still be running");
  assert.deepEqual(calls.filter((c) => c[1] === "remove"), [["mcp", "remove", "waicc-run-202610210800-aaaaaaaa"]]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).permissions.allow, ["mcp(waicc-run-202610211100-bbbbbbbb/waicc_receive)", "mcp(other/x)"]);

  const broken = settings(t, "{ not json");
  assert.throws(() => registerAgyServer({ name: "waicc-run-202610211125-cccccccc", command: "node", args: [] }, ["waicc_receive"], () => "", broken),
    /Antigravity's settings .* are not valid JSON, so WAICC left them alone and did not dispatch/);
  assert.equal(readFileSync(broken, "utf8"), "{ not json");
});
