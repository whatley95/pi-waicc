import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { coordinatorToolSpecs } from "../src/tool-specs.ts";
import { agentText, refusalNudge, stepView } from "../src/coordinator.ts";

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
  // The CLI, and through it the coordinator MCP server that Claude Code's plugin starts, too.
  for (const entry of ["coordinator.ts", "tool-specs.ts", "mcp-coordinator.ts", "cli.ts"]) visit(resolve("src", entry));
  assert.ok(![...seen].some((file) => file.includes(`${join("src", "pi")}${sep}`)), "nothing under src/pi");
  assert.deepEqual(foreign, []);
});

test("Claude Code's plugin starts the coordinator server from the plugin, in the project, and puts waicc on its Bash PATH", () => {
  const manifest = JSON.parse(readFileSync(resolve(".claude-plugin/plugin.json"), "utf8"));
  const server = manifest.mcpServers.waicc;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/src/cli.ts", "--root", "${CLAUDE_PROJECT_DIR}", "mcp", "--coordinator"]);
  const marketplace = JSON.parse(readFileSync(resolve(".claude-plugin/marketplace.json"), "utf8"));
  assert.deepEqual(marketplace.plugins.map((p: { name: string; source: string }) => [p.name, p.source]), [[manifest.name, "./"]]);
  // The launcher runs the same CLI; it is a shell script, as Claude Code's Bash tool runs it on every platform.
  assert.match(readFileSync(resolve("bin/waicc"), "utf8"), /^#!\/bin\/sh\n[^]*exec node "\$here\/src\/cli\.ts" "\$@"\n$/);
});

test("the agent never reads a handoff prompt, and a long result is bounded", () => {
  const view = { status: "WAITING_FOR_REPLY", manualHandoff: { requestId: "r1", copyPastePrompt: "SECRET PROMPT", afterReply: "a", resumeCoordinatorCommand: "b", continueCommand: "c" } };
  const text = agentText(view, { handoffClipboard: { status: "copied" } });
  assert.doesNotMatch(text, /SECRET PROMPT/);
  assert.match(text, /^\{\n {2}"handoffClipboard"/);
  assert.match(text, /Not shown to you\. \/waicc-handoff shows and copies it/);
  // Too long: the largest field gives way to a pointer, and the result stays whole JSON.
  const pointed = JSON.parse(agentText({ big: "x".repeat(40_000), status: "PLAN_READY" }));
  assert.deepEqual(pointed, { big: "(40,002 characters left out to keep this result whole: in the session's files)", status: "PLAN_READY" });
  // A list with IDs keeps them: every earlier finding is answered by ID.
  const findings = Array.from({ length: 50 }, (_, i) => ({ requestId: "r2", id: `F${i}`, severity: "medium", description: "d".repeat(1_000) }));
  const listed = JSON.parse(agentText({ codeReviewFindings: findings }));
  assert.equal(listed.codeReviewFindings.ids.length, 50);
  assert.equal(listed.codeReviewFindings.ids[0], "r2/F0 (medium)");
  assert.match(listed.codeReviewFindings.left, /^[\d,]+ characters left out to keep this result whole: in the session's files$/);
  // Only fields that never give way are left: then the end is cut.
  assert.match(agentText({ nextSteps: "x".repeat(40_000) }), /\n\[Preview bounded; inspect the session files for the full artifact\.\]$/);
  // A status cut once lost nextAction, at its end: it comes first now, and the contract becomes
  // a summary that names its file.
  const root = resolve("project");
  const contract = { version: 3, contract: { title: "T", requirements: [{}, {}], tasks: [{ acceptance: [{}, {}] }, { acceptance: [{}] }],
    decisions: [{ status: "open" }, { status: "resolved" }], assumptions: ["a".repeat(40_000)] } };
  const cut = JSON.parse(agentText({ sessionId: "s1", projectRoot: root, status: "PLAN_READY", contract, nextAction: "Assess the reply" }));
  assert.equal(Object.keys(cut)[0], "nextAction");
  assert.equal(cut.nextAction, "Assess the reply");
  assert.deepEqual(cut.contract, { version: 3, title: "T", requirements: 2, tasks: 2, acceptanceCriteria: 3, openDecisions: 1, decisions: 2,
    characters: JSON.stringify(contract.contract).length, whole: `in ${root}/.pi/pi-waicc/sessions/s1/contracts/v003/contract.json` });
  // One refusal is only the error; the advisor tool itself never nudges toward itself.
  assert.equal(refusalNudge(resolve("."), 1, "waicc_assess", 0), "");
  assert.equal(refusalNudge(resolve("."), 3, "waicc_ask_advisor", 0), "");
});

test("a step's result names what the agent wrote or just read instead of showing it again", () => {
  // The main agent wrote that contract or just adopted it, and read the reply before assessing it;
  // each result once carried all of it again.
  const contract = { version: 2, contract: { title: "T", requirements: [{}], tasks: [{ acceptance: [{}] }], decisions: [{ status: "deferred" }] } };
  const open = [{ requestId: "r2", id: "F1", severity: "high", description: "d" }];
  const view = { sessionId: "s1", status: "IMPLEMENTING", contract, requirements: "Add search", coordinatorContext: { summary: "abc" }, codeReviewFindings: open,
    lastAssessment: { requestId: "r2", mode: "review", reviewKind: "code", decision: "needs_changes", rationale: "r", dispositions: [{}], findings: [{ id: "F1", severity: "high", description: "d" }],
      coverage: [{}], checks: [{}], completion: {}, checkLogs: [], advisor: null, advice: "a", replyNormalization: [] },
    lastReply: { requestId: "r2", mode: "review", status: "ASSESSED", summary: "s", advice: "a", rationale: "r", replyNormalization: [], artifactPath: "/p/received.json" },
    nextAction: "n" };
  assert.deepEqual(stepView(view), {
    ...view,
    contract: { version: 2, title: "T", requirements: 1, tasks: 1, acceptanceCriteria: 1, openDecisions: 1, decisions: 1,
      characters: JSON.stringify(contract.contract).length, whole: "waicc_status shows the whole contract" },
    requirements: "the request and amendments: 10 characters; waicc_status shows them",
    coordinatorContext: "saved (3 characters); waicc_status shows it",
    lastAssessment: { requestId: "r2", mode: "review", reviewKind: "code", decision: "needs_changes", findings: ["F1 (high)"], checkLogs: [], advisor: null,
      whole: "waicc_status shows its rationale, dispositions, findings and the reply's report" },
    lastReply: { requestId: "r2", mode: "review", status: "ASSESSED", artifactPath: "/p/received.json" },
  });
  // The open code-review findings a completion report answers stay whole.
  assert.deepEqual((stepView(view) as { codeReviewFindings: unknown }).codeReviewFindings, open);
  // Nothing to shorten: as it was.
  assert.deepEqual(stepView({ status: "DRAFT", contract: null }), { status: "DRAFT", contract: null });
});
