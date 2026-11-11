import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { coordinatorToolSpecs } from "../src/tool-specs.ts";
import { agentText, refusalNudge } from "../src/coordinator.ts";

test("Pi registers every shared coordinator tool exactly as written for all hosts", () => {
  const registered = new Map<string, any>();
  waicc({
    registerCommand() {}, registerTool: (tool: any) => registered.set(tool.name, tool), on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI, {});
  for (const spec of coordinatorToolSpecs) {
    const tool = registered.get(spec.name);
    assert.ok(tool, `${spec.name} is registered`);
    for (const field of ["label", "description", "promptSnippet", "promptGuidelines", "parameters"] as const)
      assert.deepEqual(tool[field], spec[field], `${spec.name}.${field}`);
  }
});

test("the shared coordinator code loads without Pi or TypeBox, so another host can run it with Node alone", () => {
  // Every module the shared code imports, followed through the source tree.
  const seen = new Set<string>(), foreign: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, from] of readFileSync(file, "utf8").matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)) {
      if (from.startsWith(".")) {
        const target = resolve(dirname(file), from);
        assert.ok(existsSync(target), `${file} imports ${from}`);
        visit(target);
      } else if (!from.startsWith("node:")) foreign.push(`${file.slice(resolve("src").length + 1)} imports ${from}`);
    }
  };
  for (const entry of ["coordinator.ts", "tool-specs.ts"]) visit(resolve("src", entry));
  assert.ok(![...seen].some((file) => file.includes(`${join("src", "pi")}`)), "nothing under src/pi");
  assert.deepEqual(foreign, []);
});

test("the agent never reads a handoff prompt, and a long result is bounded", () => {
  const view = { status: "WAITING_FOR_REPLY", manualHandoff: { requestId: "r1", copyPastePrompt: "SECRET PROMPT", afterReply: "a", resumeCoordinatorCommand: "b", continueCommand: "c" } };
  const text = agentText(view, { handoffClipboard: { status: "copied" } });
  assert.doesNotMatch(text, /SECRET PROMPT/);
  assert.match(text, /^\{\n {2}"handoffClipboard"/);
  assert.match(text, /Not shown to you\. \/waicc-handoff shows and copies it/);
  assert.match(agentText({ big: "x".repeat(40_000) }), /\n\[Preview bounded; inspect the session files for the full artifact\.\]$/);
  // One refusal is only the error; the advisor tool itself never nudges toward itself.
  assert.equal(refusalNudge(resolve("."), 1, "waicc_assess", 0), "");
  assert.equal(refusalNudge(resolve("."), 3, "waicc_ask_advisor", 0), "");
});
