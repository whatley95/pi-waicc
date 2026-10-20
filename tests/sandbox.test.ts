import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { checkCommand, runRecipientCheck } from "../src/checks.ts";
import { runAgent } from "../src/dispatch.ts";
import { loadAgentConfig, sandboxSettings } from "../src/profiles.ts";
import { receiveHandoff } from "../src/recipient.ts";
import { macProfile, sandboxAvailable, sandboxPlan, type SandboxSettings } from "../src/sandbox.ts";
import { snapshot } from "../src/source.ts";
import { createSession, prepare } from "../src/workflow.ts";

const on = (mode: SandboxSettings["mode"], network = false, allowWrite: string[] = []): SandboxSettings => ({ mode, network, allowWrite });

function project(t: TestContext) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const agentDir = join(base, "agent"), root = join(base, "shop");
  mkdirSync(agentDir);
  mkdirSync(root);
  writeFileSync(join(root, "app.txt"), "app");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  return { agentDir, root };
}
/** A review handoff whose recipient may run pre-approved checks. */
function reviewer(root: string) {
  const s = createSession(root, "Add a side menu");
  prepare(root, s.id, {
    title: "Side menu", requirements: [{ id: "R1", text: "Add a side menu", sourceQuote: "Add a side menu" }],
    exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
    tasks: [{ id: "T1", title: "Menu", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"], acceptance: [{ id: "AC1", text: "Opens", requirementIds: ["R1"], verification: "Open it" }] }],
  }, "review", "Review", 0);
  return { id: s.id, pin: receiveHandoff(root, s.id).pin };
}

test("off runs the check as before; macOS wraps it in sandbox-exec with writes only below its folders and no IP network", () => {
  assert.deepEqual(sandboxPlan("npm", ["test"], "/work/shop", on("off"), "darwin", () => "sandbox-exec"), { program: "npm", args: ["test"], sandbox: null, note: null });
  const plan = sandboxPlan("npm", ["test"], "/work/shop", on("auto", false, ["/opt/cache"]), "darwin", () => "sandbox-exec");
  assert.equal(plan.program, "/usr/bin/sandbox-exec");
  assert.equal(plan.args[0], "-p");
  assert.deepEqual(plan.args.slice(2), ["npm", "test"]);
  const profile = plan.args[1];
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(subpath "\/work\/shop"\)/);
  assert.match(profile, /\(subpath "\/opt\/cache"\)/);
  assert.ok(plan.sandbox!.writable.includes(tmpdir()), "the temp folder stays writable");
  assert.match(profile, /\(deny network-outbound \(remote ip\)\)/);
  assert.doesNotMatch(sandboxPlan("npm", [], "/work/shop", on("auto", true), "darwin", () => "sandbox-exec").args[1], /deny network/, "network allowed when you say so");
  assert.match(macProfile(['/a "b" \\c'], false), /\(subpath "\/a \\"b\\" \\\\c"\)/, "quotes and backslashes in a path cannot end the string");
});

test("Linux wraps it in bwrap: the system read-only, its folders writable, no network unless allowed", (t) => {
  const { root } = project(t);
  const plan = sandboxPlan("npm", ["test"], root, on("required"), "linux", () => "bwrap");
  assert.equal(plan.program, "bwrap");
  const args = plan.args;
  assert.deepEqual(args.slice(args.indexOf("--") + 1), ["npm", "test"]);
  assert.deepEqual(args.slice(args.indexOf("--ro-bind"), args.indexOf("--ro-bind") + 3), ["--ro-bind", "/", "/"]);
  assert.ok(args.join(" ").includes(`--bind ${root} ${root}`));
  assert.ok(args.includes("--unshare-net"));
  assert.deepEqual(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2), ["--chdir", root]);
  assert.ok(!sandboxPlan("npm", [], root, on("auto", true), "linux", () => "bwrap").args.includes("--unshare-net"));
});

test("without a sandbox, auto runs the check and says so; required refuses before anything is recorded or run", async (t) => {
  const { root } = project(t);
  const auto = sandboxPlan("npm", ["test"], root, on("auto"), "win32", () => null);
  assert.deepEqual([auto.program, auto.args, auto.sandbox], ["npm", ["test"], null]);
  assert.match(auto.note!, /^No sandbox: Windows has no sandbox WAICC can use yet, so the check ran with your own permissions\./);
  assert.throws(() => sandboxPlan("npm", [], root, on("required"), "linux", () => null), /"sandbox\.checks": "required"\), but bubblewrap \(bwrap\) is not installed or not permitted here\. The check was not run/);

  const { id, pin } = reviewer(root);
  const command = checkCommand({ program: "npm", args: ["test"], timeoutMs: 1000 });
  let ran = 0;
  const run = async () => (ran++, { stdout: "ok", stderr: "", code: 0, killed: false });
  await assert.rejects(runRecipientCheck(root, pin, command, snapshot(root).fingerprint, run, undefined, { sandbox: on("required"), platform: "win32" }), /The check was not run/);
  assert.equal(ran, 0);
  const checks = join(root, ".pi", "pi-waicc", "sessions", id, "rounds");
  assert.ok(!readdirSync(checks, { recursive: true }).some((name) => String(name).includes("checks")), "nothing was recorded");
  const result = await runRecipientCheck(root, pin, command, snapshot(root).fingerprint, run, undefined, { sandbox: on("auto"), platform: "win32" });
  assert.equal(ran, 1);
  assert.equal(result.sandbox, null);
  assert.match(result.sandboxNote!, /ran with your own permissions/);
  assert.match(result.nextAction, /ran with your own permissions/);
});

test("the sandbox setting is yours alone: off by default, validated, and refused in a project file", (t) => {
  const { agentDir, root } = project(t);
  assert.deepEqual(sandboxSettings(root), { mode: "off", network: false, allowWrite: [] });
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ sandbox: { checks: "required", network: true, allowWrite: ["~/.cache", "/opt/cache"] } }));
  assert.deepEqual(sandboxSettings(root), { mode: "required", network: true, allowWrite: ["~/.cache", "/opt/cache"] });
  for (const [sandbox, message] of [
    [{ checks: "always" }, /"sandbox\.checks" must be "off", "auto" or "required"/],
    [{ network: "no" }, /"sandbox\.network" must be true or false/],
    [{ allowWrite: ["cache"] }, /"sandbox\.allowWrite" must be a list of at most 20 absolute folders/],
    [{ shell: true }, /"sandbox" takes only "checks", "network" and "allowWrite"/],
  ] as const) {
    writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ sandbox }));
    assert.throws(() => loadAgentConfig(root), message);
  }
  writeFileSync(join(agentDir, "waicc-agents.json"), "{}");
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "waicc-agents.json"), JSON.stringify({ sandbox: { checks: "off" } }));
  assert.throws(() => loadAgentConfig(root), /"sandbox" is allowed only in your user file/, "a repository cannot loosen what checks may touch");
});

// Runs only where the system's sandbox works (macOS; Linux with bubblewrap permitted).
test("in the real sandbox a check writes its own folder, but not outside it, and reaches no network", { skip: !sandboxAvailable() && "no sandbox on this system" }, async (t) => {
  const { root } = project(t);
  const outside = mkdtempSync(join(homedir(), ".waicc-sandbox-test-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const node = (script: string, settings = on("required")) => {
    const plan = sandboxPlan(process.execPath, ["-e", script], root, settings);
    return runAgent(plan.program, plan.args, { cwd: root, timeout: 20_000 });
  };
  const inside = await node(`require("fs").writeFileSync("made.txt", "ok")`);
  assert.equal(inside.code, 0, inside.stderr);
  assert.ok(existsSync(join(root, "made.txt")));
  const escaped = await node(`require("fs").writeFileSync(${JSON.stringify(join(outside, "escaped.txt"))}, "no")`);
  assert.notEqual(escaped.code, 0);
  assert.ok(!existsSync(join(outside, "escaped.txt")));
  const allowed = await node(`require("fs").writeFileSync(${JSON.stringify(join(outside, "allowed.txt"))}, "ok")`, on("required", false, [outside]));
  assert.equal(allowed.code, 0, allowed.stderr);
  const network = await node(`const s = require("net").connect(53, "1.1.1.1"); s.on("connect", () => process.exit(0)); s.on("error", () => process.exit(3)); setTimeout(() => process.exit(4), 5000);`);
  assert.notEqual(network.code, 0, "no IP connection from inside");
});
