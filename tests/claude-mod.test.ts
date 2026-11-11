import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { humanOnlyCommand, sessionArgs, slashCommands, slashFor, splitArgs, statusLine, waiccSection } from "../src/claude/commands.ts";
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
  assert.deepEqual([...seen].map((file) => basename(file)).sort(), ["commands.ts", "register.ts", "status-table.ts"]);
  assert.deepEqual(JSON.parse(readFileSync(resolve("hooks/hooks.json"), "utf8")), { modules: ["./register.ts"] });
});
