import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { listSessions, loadSession } from "../src/files.ts";
import type { AgentRunner } from "../src/dispatch.ts";
import { huntRequirements, loadHunt, parseTriage, pickBugs, reportBugs, startHunt, triageBugs, type Hunt } from "../src/hunt.ts";

/** A Git project with two source files, and your user file with `user`. */
function project(t: TestContext, user: object = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-hunt-")));
  const root = join(base, "app"), agentDir = join(base, "agent");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify(user));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-hunt-"));
    rmSync(base, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "--quiet", root]);
  writeFileSync(join(root, "src", "pay.ts"), "export const total = (a: number[]) => a.reduce((x, y) => x + y);\n");
  writeFileSync(join(root, "src", "user.ts"), "export const name = (u: { name?: string }) => u.name.trim();\n");
  return root;
}
const bug = (file = "src/pay.ts", severity = "high") => ({ file, line: 1, trigger: "an empty list", wrong: "reduce throws instead of returning 0", severity });

test("a report names every problem at once, and a changed source refuses it with the files named", (t) => {
  const root = project(t);
  const hunt = startHunt(root, "src");
  assert.throws(() => reportBugs(root, hunt.id, [{ file: "src/missing.ts", line: 0, trigger: "", wrong: "x", severity: "urgent" }]), (error: Error) => {
    for (const part of ["4 problems", "bugs[0].file: src/missing.ts is not a file", "bugs[0].line", "bugs[0].trigger", "bugs[0].severity: high, medium or low"])
      assert.ok(error.message.includes(part), part);
    return true;
  });
  assert.throws(() => reportBugs(root, hunt.id, Array.from({ length: 16 }, () => bug())), /At most 15 bugs per hunt/);

  writeFileSync(join(root, "src", "pay.ts"), "// fixed quietly\n");
  assert.throws(() => reportBugs(root, hunt.id, [bug()]), /source changed during the bug hunt.*Changed: src\/pay\.ts\./s);

  const fresh = startHunt(root, "src");
  const reported = reportBugs(root, fresh.id, [bug(`${root}/src/pay.ts`), bug("./src/user.ts", "medium")]);
  assert.deepEqual(reported.bugs.map((b) => [b.id, b.file, b.verdict]), [["B1", "src/pay.ts", "untriaged"], ["B2", "src/user.ts", "untriaged"]]);
  assert.throws(() => startHunt(root, "  "), /Usage: \/waicc-bug-hunt <scope>/);
});

test("the advisor's verdict lines are read, and anything else is ignored", () => {
  const verdicts = parseTriage("Here is my check.\nB1 | confirmed | reduce has no seed (src/pay.ts:1).\n- `B2` | **Not-a-bug** | name is always set by the caller.\nB3 maybe\nB1 | plausible | duplicate ignored");
  assert.deepEqual([...verdicts], [
    ["B1", { verdict: "confirmed", reason: "reduce has no seed (src/pay.ts:1)." }],
    ["B2", { verdict: "not a bug", reason: "name is always set by the caller." }],
  ]);
});

test("picking: all takes confirmed and unchecked bugs, all+plausible adds plausible, IDs take exactly those", () => {
  const hunt = { scope: "src", triage: { by: "sonnet" }, bugs: [
    { id: "B1", verdict: "confirmed" }, { id: "B2", verdict: "plausible" }, { id: "B3", verdict: "not a bug" }, { id: "B4", verdict: "untriaged" },
  ] } as unknown as Hunt;
  const ids = (selection: string) => pickBugs(hunt, selection).map((b) => b.id);
  assert.deepEqual(ids("all"), ["B1", "B4"]);
  assert.deepEqual(ids("ALL+plausible"), ["B1", "B2", "B4"]);
  assert.deepEqual(ids("b3, B1"), ["B1", "B3"], "you can overrule the advisor by naming a bug");
  assert.throws(() => pickBugs(hunt, "B9"), /No B9 in this hunt; its bugs are B1, B2, B3, B4/);
  assert.throws(() => pickBugs(hunt, ""), /Usage: \/waicc-bug-pick/);
  assert.throws(() => pickBugs({ ...hunt, bugs: [{ id: "B1", verdict: "not a bug" }] } as unknown as Hunt, "all"), /No bug is confirmed\. Name the ones you still want fixed/);
});

test("without an advisor the bugs stay untriaged, and the requirements carry each bug's evidence", async (t) => {
  const root = project(t);
  const hunt = startHunt(root, "src");
  reportBugs(root, hunt.id, [bug()]);
  const triaged = await triageBugs(root, hunt.id, null);
  assert.equal(triaged.status, "TRIAGED");
  assert.match(triaged.triage!.note!, /No advisor role is set/);
  const text = huntRequirements(triaged, triaged.bugs);
  for (const part of ["Fix these bugs, found by a bug hunt over src.", "write a test or repro that fails", "B1 (high, untriaged) at src/pay.ts:1. Trigger: an empty list"])
    assert.ok(text.includes(part), part);
});

function harness(root: string, answer: string | null) {
  const commands = new Map<string, any>(), tools = new Map<string, any>(), prompts: string[] = [], confirms: string[] = [], notices: string[] = [], asked: string[][] = [];
  let yes = true;
  const run: AgentRunner = async (program, args) => {
    asked.push([program, ...args]);
    return { stdout: answer ? `${JSON.stringify({ type: "result", subtype: "success", result: answer })}\n` : "", stderr: "", code: answer ? 0 : 1, killed: false };
  };
  waicc({
    registerCommand: (name: string, command: any) => commands.set(name, command), registerTool: (tool: any) => tools.set(tool.name, tool), on() {},
    appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage: (m: string) => prompts.push(m),
  } as unknown as ExtensionAPI, { runAgent: run });
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "chat", getBranch: () => [], getEntries: () => [] },
    ui: { notify: (m: string) => notices.push(m), setStatus() {}, setWidget() {}, confirm: async (title: string, body: string) => (confirms.push(`${title}\n${body}`), yes) },
  };
  return {
    prompts, confirms, notices, asked, say: (answer: boolean) => (yes = answer),
    run: (name: string, args = "") => commands.get(name).handler(args, ctx),
    report: (huntId: string, bugs: unknown[]) => tools.get("waicc_report_bugs").execute("call", { huntId, bugs }, undefined, undefined, ctx),
  };
}

test("/waicc-bug-hunt → report → advisor triage → /waicc-bug-pick plans the picked bugs", async (t) => {
  const root = project(t, { profiles: { sonnet: { via: "claude", model: "sonnet" } }, roles: { advisor: "sonnet" }, autoAdvisor: false });
  const h = harness(root, "B1 | confirmed | reduce has no seed (src/pay.ts:1).\nB2 | not a bug | callers always pass a name.");
  await h.run("waicc-bug-pick", "all");
  assert.match(h.notices.at(-1)!, /No bug hunt is waiting to be picked from/);

  await h.run("waicc-bug-hunt", "src");
  const huntId = /Bug hunt ([0-9a-f-]{36})/.exec(h.prompts[0])![1];
  assert.match(h.prompts[0], /read-only scan\. Do not edit/);
  assert.match(h.prompts[0], /call waicc_report_bugs once with huntId/);
  await h.run("waicc-bug-pick", "all");
  assert.match(h.notices.at(-1)!, /has not been reported yet/);

  const reply = await h.report(huntId, [bug(), bug("src/user.ts", "medium")]);
  const table = reply.content[0].text;
  assert.match(table, /2 candidates, 1 confirmed, 0 plausible, 1 not a bug \(checked by sonnet\)/);
  assert.match(table, /\| B1 \| confirmed \| high \| src\/pay\.ts:1 \|/);
  assert.match(table, /Do not start fixing or planning/);
  assert.equal(h.asked.length, 1, "one advisor run for the whole list, even with autoAdvisor off");
  assert.ok(h.asked[0].includes("--disallowedTools"), "the advisor triages read-only");
  await assert.rejects(h.report(huntId, [bug()]), /already reported/);

  await h.run("waicc-bug-pick", "all");
  const session = loadSession(root, listSessions(root)[0].id);
  assert.equal(session.objective, "planning");
  assert.match(session.requirements[0], /B1 \(high, confirmed\) at src\/pay\.ts:1/);
  assert.ok(!session.requirements[0].includes("B2"), "a bug ruled out stays out of all");
  assert.match(h.prompts.at(-1)!, /The human picked B1 from a bug hunt/);
  assert.equal(loadHunt(root, huntId).sessionId, session.id);
  await h.run("waicc-bug-pick", "B2");
  assert.match(h.notices.at(-1)!, /No bug hunt is waiting to be picked from/, "a hunt is picked once");
});

test("picking more than 10 bugs asks first, and No starts nothing", async (t) => {
  const root = project(t);
  const h = harness(root, null);
  await h.run("waicc-bug-hunt", ".");
  const huntId = /Bug hunt ([0-9a-f-]{36})/.exec(h.prompts[0])![1];
  const reply = await h.report(huntId, Array.from({ length: 12 }, (_, i) => bug("src/pay.ts", i < 3 ? "high" : "low")));
  assert.match(reply.content[0].text, /12 untriaged.*No advisor role is set/s);
  assert.deepEqual(h.asked, [], "no advisor, no run");

  h.say(false);
  await h.run("waicc-bug-pick", "all");
  assert.match(h.confirms[0], /^Plan all 12 bugs in one session\?/);
  assert.match(h.confirms[0], /\/waicc-bug-pick B1 B2 B3 now and the rest later/);
  assert.equal(listSessions(root).length, 0);
  h.say(true);
  await h.run("waicc-bug-pick", "all");
  assert.equal(listSessions(root).length, 1);
});
