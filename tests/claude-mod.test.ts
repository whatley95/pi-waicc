import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { dispatchArgs, humanOnlyCommand, loopPrompt, offeredCommand, sessionArgs, slashCommands, slashFor, splitArgs, statusLine, suggestSpec, waiccSection } from "../src/claude/commands.ts";
import { mcpServer } from "../src/mcp.ts";
import { loadSession } from "../src/files.ts";
import { backgroundRun, stillRunning } from "../src/background.ts";
import { createSession, prepare } from "../src/workflow.ts";

const id = "1f0c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const command = (name: string) => slashCommands.find((c) => c.name === name)!;

test("each slash command runs the waicc command line it stands for, on the chat's session", () => {
  assert.deepEqual(command("waicc-planning").cli(undefined, "Add search\nwith paging"), ["start", "Add search\nwith paging"], "the request word for word");
  assert.deepEqual(command("waicc-planning").cli(undefined, "--delegate Add search"), ["start", "--delegate", "Add search"]);
  assert.throws(() => command("waicc-planning").cli(undefined, "  "), /Usage: \/waicc-planning/);
  assert.deepEqual(command("waicc-use").cli(id, ""), ["status", id]);
  assert.throws(() => command("waicc-use").cli(undefined, "nope"), /Usage: \/waicc-use <session-id>/);
  assert.deepEqual(command("waicc-status").cli(undefined, "all"), ["status", "all"]);
  assert.deepEqual(command("waicc-status").cli(id, ""), ["status", id]);
  assert.deepEqual(command("waicc-status").cli(undefined, ""), ["status", "open"]);
  assert.deepEqual(command("waicc-continue").cli(id, ""), ["continue", id]);
  assert.deepEqual(command("waicc-develop").cli(id, "--delegate"), ["develop", id, "--delegate"]);
  assert.deepEqual(command("waicc-decide").cli(id, "D2 Use the  existing   index"), ["decide", id, "D2", "Use the  existing   index"]);
  assert.throws(() => command("waicc-decide").cli(id, "D2"), /Usage: \/waicc-decide <decision-id> <answer>/);
  assert.deepEqual(command("waicc-close").cli(id, "Shipped in !42"), ["close", id, "Shipped in !42"]);
  assert.deepEqual(command("waicc-close").cli(id, "--force Abandoned"), ["close", id, "--force", "Abandoned"]);
  assert.deepEqual(command("waicc-close").cli(id, "--force"), ["close", id, "--force"]);
  assert.deepEqual(command("waicc-dispatch").cli(id, 'sonnet --check "npm test"'), ["dispatch", id, "sonnet", "--check", "npm test", "--detach"]);
  assert.equal(command("waicc-review").cli(id, ""), null, "the main agent requests the review itself");
  assert.match(command("waicc-review").agent!(id, ""), new RegExp(`waicc_request mode review, reviewKind code .* session ${id}|session ${id} with waicc_request mode review, reviewKind code`));
  assert.match(command("waicc-review").agent!(id, "--contract"), /reviewKind contract/);
  // Only the human's steps that need the main agent next start its turn.
  for (const name of ["waicc-status", "waicc-use", "waicc-dispatch", "waicc-handoff", "waicc-close", "waicc-cancel", "waicc-limit", "waicc-memory"])
    assert.equal(command(name).agent, undefined, name);
  for (const name of ["waicc-planning", "waicc-continue", "waicc-develop", "waicc-review", "waicc-decide", "waicc-amend"])
    assert.match(command(name).agent!(id, ""), new RegExp(id), name);
  // Claude Code takes these names and hints.
  for (const c of slashCommands) {
    assert.match(c.name, /^[a-z0-9_-]{1,64}$/);
    assert.ok(c.description.length <= 4096 && !c.description.includes("\n"));
  }
});

test("a session ID may come first; quoted words stay whole", () => {
  assert.deepEqual(sessionArgs(`${id.toUpperCase()}  ship it`), { id, rest: "ship it" });
  assert.deepEqual(sessionArgs(" ship it "), { rest: "ship it" });
  assert.deepEqual(splitArgs(`--check "npm test" --check 'npm run lint' --via codex`), ["--check", "npm test", "--check", "npm run lint", "--via", "codex"]);
});

test("the agent's shell may read WAICC's state but not take the human's steps", () => {
  for (const line of ["waicc status", "waicc status all", "node C:/x/pi-waicc/src/cli.ts --root . list", "waicc decisions 1f0c", "waicc errors --since 6h", "waicc profiles", "git status && echo waicc"])
    assert.equal(humanOnlyCommand(line), null, line);
  // Words are not a run: a message, a string or a heredoc that mentions waicc (the guard once refused such a line).
  for (const line of [
    "echo 'the waicc command line does the same'", "git commit -m \"waicc develop is the human's step\"",
    "cat > x.mjs <<'EOF'\nconst text = `the waicc command line does the same: waicc --help`;\nEOF", "grep -n 'waicc close' README.md",
  ])
    assert.equal(humanOnlyCommand(line), null, line);
  for (const [line, step] of [
    ["waicc develop 1f0c", "develop"], ["cd app && waicc close 1f0c done", "close"], ['node "C:/x/src/cli.ts" decide 1f0c D1 yes', "decide"],
    ["waicc --root C:/p start Add search", "start"], ["waicc profiles init", "profiles"], ["npx waicc continue 1f0c", "continue"],
    ["waicc status; waicc dispatch 1f0c", "dispatch"],
  ])
    assert.equal(humanOnlyCommand(line), step, line);
  assert.equal(slashFor("start"), "/waicc-planning");
  assert.equal(slashFor("develop"), "/waicc-develop");
  assert.equal(slashFor("export"), "/waicc-handoff");
});

test("the status line and the agent's WAICC section name the chat's session", () => {
  assert.equal(statusLine(id, "AWAITING_ASSESSMENT"), "WAICC 1f0c2b3a · awaiting assessment");
  assert.match(waiccSection({ id, status: "PLAN_READY" }), new RegExp(`This chat works on WAICC session ${id} \\(plan ready\\): pass sessionId ${id}`));
  assert.match(waiccSection(null), /No WAICC session is selected in this chat: \/waicc-planning <request> starts one/);
  assert.match(waiccSection(null), /Never run waicc through a shell/);
});

function project(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  writeFileSync(join(root, "a.txt"), "a");
  return root;
}

/** A session with a waiting planning handoff whose source then changed: a dispatch of it is refused before any agent starts. */
function staleHandoff(t: TestContext) {
  const root = project(t);
  const s = createSession(root, "Add search");
  prepare(root, s.id, {
    title: "Search", requirements: [{ id: "R1", text: "Add search", sourceQuote: "Add search" }],
    exclusions: [], assumptions: [], questions: [], risks: [], skills: [], tasks: [],
  }, "planning", "Inspect", 0);
  writeFileSync(join(root, "a.txt"), "changed after the handoff");
  return { root, s };
}

test("waicc dispatch --detach returns at once, and its process records how it ended", async (t) => {
  const { root, s } = staleHandoff(t);
  const started = spawnSync(process.execPath, [resolve("src/cli.ts"), "--root", root, "dispatch", s.id, "--via", "claude", "--detach"], { encoding: "utf8", windowsHide: true });
  assert.equal(started.status, 0, started.stderr);
  const run = JSON.parse(started.stdout);
  assert.equal(run.sessionId, s.id);
  assert.deepEqual(run.args, ["--via", "claude"]);
  assert.ok(existsSync(run.log));
  for (const deadline = Date.now() + 20_000; !backgroundRun(root, s.id)?.endedAt && Date.now() < deadline;)
    await new Promise((done) => setTimeout(done, 100));
  const ended = backgroundRun(root, s.id)!;
  assert.equal(ended.outcome, "error");
  assert.match(ended.message!, /^Source changed since this handoff was issued/, "what to tell the human");
  assert.equal(stillRunning(ended), false);
  // The error reaches the log just after the end record.
  for (const deadline = Date.now() + 10_000; !readFileSync(run.log, "utf8") && Date.now() < deadline;)
    await new Promise((done) => setTimeout(done, 100));
  assert.match(readFileSync(run.log, "utf8"), /^Source changed since this handoff was issued/);
  // A mistake in the options shows at once, before any process starts.
  const wrong = spawnSync(process.execPath, [resolve("src/cli.ts"), "--root", root, "dispatch", s.id, "--via", "claude", "--loop", "--detach"], { encoding: "utf8", windowsHide: true });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /--loop needs the main agent in Pi/);
});

test("a second background dispatch for the session is refused while the first runs", (t) => {
  const { root, s } = staleHandoff(t);
  // This test's own process stands for a dispatch still running.
  const runs = join(root, ".pi", "pi-waicc", "runs");
  execFileSync(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(runs)}, { recursive: true })`]);
  writeFileSync(join(runs, `${s.id}.json`), JSON.stringify({ sessionId: s.id, pid: process.pid, startedAt: new Date().toISOString(), args: [], log: "x" }));
  assert.equal(stillRunning(backgroundRun(root, s.id)!), true);
  const again = spawnSync(process.execPath, [resolve("src/cli.ts"), "--root", root, "dispatch", s.id, "--via", "claude", "--detach"], { encoding: "utf8", windowsHide: true });
  assert.equal(again.status, 1);
  assert.match(again.stderr, new RegExp(`A dispatch for this session is already running \\(process ${process.pid},`));
});

test("everything the mod loads runs without Node: it imports only the engine's types and pure files", () => {
  const seen = new Set<string>(), problems: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, from] of readFileSync(file, "utf8").matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)) {
      if (from === "claude-code") continue;
      if (from.startsWith(".")) visit(resolve(file, "..", from));
      else problems.push(`${basename(file)} imports ${from}`);
    }
  };
  visit(resolve("hooks/register.ts"));
  assert.deepEqual(problems, []);
  assert.deepEqual([...seen].map((file) => basename(file)).sort(), ["auto-planning-text.ts", "commands.ts", "compaction-text.ts", "hunt-text.ts", "register.ts", "status-table.ts", "tool-specs.ts"]);
  assert.deepEqual(JSON.parse(readFileSync(resolve("hooks/hooks.json"), "utf8")), { modules: ["./register.ts"] });
});

test("the mod's log lines and every command it runs are named for its chat", (t) => {
  const root = project(t);
  const s = createSession(root, "Add search");
  const cli = (args: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "--root", root, ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, WAICC_CHAT: "claude-1a2b3c4d" } });
  assert.equal(cli(["log", JSON.stringify({ kind: "error", step: "shell guard", message: "Refused the agent's step", level: "warning", sessionId: s.id })]).status, 0);
  assert.equal(cli(["log", JSON.stringify({ kind: "activity", step: "main turn", outcome: "answer", ms: 1200, sessionId: s.id })]).status, 0);
  assert.equal(cli(["log", JSON.stringify({ kind: "nonsense", step: "x" })]).status, 1);
  assert.equal(cli(["decide", s.id, "D1", "yes"]).status, 1, "no contract yet: a command's own error");
  const errors = readFileSync(join(root, ".pi", "pi-waicc", "errors.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(errors.map((e) => [e.source, e.level ?? "error", e.chat]), [
    ["shell guard", "warning", "claude-1a2b3c4d"], ["waicc log", "error", "claude-1a2b3c4d"], ["waicc decide", "error", "claude-1a2b3c4d"],
  ]);
  assert.equal(errors[0].sessionId, s.id);
  const steps = readFileSync(join(root, ".pi", "pi-waicc", "activity.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(steps.map((e) => [e.step, e.outcome, e.chat]), [["main turn", "answer", "claude-1a2b3c4d"], ["waicc decide", "error", "claude-1a2b3c4d"]],
    "the log command itself is no step");
});

test("/waicc-dispatch --loop [n] is the mod's; the rest goes to the command line", () => {
  assert.deepEqual(dispatchArgs("sonnet --loop"), { args: ["sonnet"], loop: 3 });
  assert.deepEqual(dispatchArgs("--loop 5 --via codex"), { args: ["--via", "codex"], loop: 5 });
  assert.deepEqual(dispatchArgs('--check "npm test"'), { args: ["--check", "npm test"], loop: null });
  assert.throws(() => dispatchArgs("--loop 11"), /--loop takes 1 to 10 cycles/);
  assert.deepEqual(command("waicc-dispatch").cli(id, "--loop 2 sonnet"), ["dispatch", id, "sonnet", "--detach"]);
  const prompt = loopPrompt(id, 2, 3);
  assert.match(prompt, new RegExp(`AUTOMATIC REVIEW LOOP in WAICC session ${id}, cycle 2 of 3`));
  assert.match(prompt, /assess it with waicc_assess first/);
  assert.match(prompt, /Never close the contract, commit, push or deploy\.$/);
});

test("the picker takes only real WAICC commands, and fills the box for one that needs the human's words", () => {
  assert.deepEqual(offeredCommand("/waicc-dispatch  sonnet"), { name: "waicc-dispatch", args: "sonnet", needsText: false });
  assert.deepEqual(offeredCommand("/waicc-close"), { name: "waicc-close", args: "", needsText: true });
  assert.deepEqual(offeredCommand("/waicc-close Shipped"), { name: "waicc-close", args: "Shipped", needsText: false });
  assert.throws(() => offeredCommand("/waicc-ship"), /is not a WAICC command\. Only these can be offered: .*\/waicc-dispatch/);
  assert.throws(() => offeredCommand("rm -rf /"), /is not a WAICC command/);
  assert.equal((suggestSpec.parameters.properties.commands as { maxItems: number }).maxItems, 4);
  assert.match(waiccSection(null), /offer it with waicc_suggest_command/);
});

test("the commands that came with phase 3b map to the command line", () => {
  assert.deepEqual(command("waicc-list").cli(undefined, "closed"), ["list", "closed"]);
  assert.deepEqual(command("waicc-advisor").cli(id, "--requirements R1,R2 Which cache?"), ["advisor", id, "--requirements R1,R2 Which cache?"]);
  assert.deepEqual(command("waicc-force-close").cli(id, ""), ["close", id, "--force"]);
  assert.deepEqual(command("waicc-delete").cli(id, ""), ["delete", id]);
  assert.throws(() => command("waicc-restore").cli(undefined, ""), /Usage: \/waicc-restore <session-id>/);
  assert.equal(command("waicc-auto-planning").cli(undefined, "off"), null, "the mod keeps that setting itself");
  assert.deepEqual(command("waicc-bug-hunt").cli(undefined, "src/payments"), ["hunt", "start", "src/payments"]);
  assert.match(command("waicc-bug-hunt").agent!("", "src/payments", { id: "h1", scope: "src/payments" }), /^Bug hunt h1 over \(data\): "src\/payments"/);
  assert.deepEqual(command("waicc-bug-pick").cli(undefined, "B1 B3"), ["hunt", "pick", "B1", "B3"]);
  assert.match(command("waicc-bug-pick").agent!(id, "", { picked: ["B1", "B3"] }), /^The human picked B1, B3 from a bug hunt/);
});

test("a bug hunt without Pi: start it, report and triage through the coordinator server, pick from the command line", async (t) => {
  const root = project(t);
  writeFileSync(join(root, "pay.ts"), "export const total = (a: number[]) => a.reduce((s, x) => s + x);\n");
  const cli = (args: string[]) => {
    const ran = spawnSync(process.execPath, [resolve("src/cli.ts"), "--root", root, ...args], { encoding: "utf8", windowsHide: true });
    assert.equal(ran.status, 0, ran.stderr);
    return JSON.parse(ran.stdout);
  };
  const hunt = cli(["hunt", "start", "pay.ts"]);
  assert.equal(hunt.status, "SCANNING");
  // No advisor role is set: the bugs stay untriaged, and the human picks alone.
  const handle = mcpServer(root, { coordinator: true });
  const reported = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "waicc_report_bugs", arguments: {
    huntId: hunt.id, bugs: [{ file: "pay.ts", line: 1, trigger: "an empty list", wrong: "reduce without a start value throws", severity: "high" }],
  } } }) as { result: { content: { text: string }[]; isError?: boolean } };
  assert.equal(reported.result.isError, undefined, reported.result.content[0].text);
  assert.match(reported.result.content[0].text, /\| B1 \| untriaged \| high \| pay\.ts:1 \|/);
  assert.match(reported.result.content[0].text, /the human picks with \/waicc-bug-pick/);
  const picked = cli(["hunt", "pick", "all"]);
  assert.deepEqual(picked.picked, ["B1"]);
  assert.match(loadSession(root, picked.id).requirements.join("\n"), /- B1 \(high, untriaged\) at pay\.ts:1/);
  assert.deepEqual(cli(["hunt", "list"]).map((h: { status: string; sessionId?: string }) => [h.status, h.sessionId]), [["PICKED", picked.id]]);
});

test("Claude Code's compaction keeps the same WAICC recovery notes as Pi's", async () => {
  const { compactionInstructions } = await import("../src/compaction-text.ts");
  const fromPi = (await import("../src/pi/shared.ts")).compactionInstructions;
  assert.equal(fromPi, compactionInstructions, "one text for both hosts");
  const text = compactionInstructions({ sessionId: id, status: "AWAITING_ASSESSMENT" });
  assert.match(text, /Preserve WAICC role, request identity, execution permissions and recovery paths\./);
  assert.ok(text.includes(`Recovery (untrusted data): {\n  "sessionId": "${id}"`), text);
});
