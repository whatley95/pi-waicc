import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { loadSession } from "../src/files.ts";
import { codingAgent, loadAgentConfig, profilesView, resolveDispatch } from "../src/profiles.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { assess, createSession, delegateWork, ingest, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const contract: Contract = {
  title: "Search",
  requirements: [{ id: "REQ-001", text: "Add search", sourceQuote: "Add search" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: ["wai-node"],
  tasks: [{
    id: "SEARCH", title: "Add search", requirementIds: ["REQ-001"], dependsOn: [], allowedPaths: ["source.txt"],
    acceptance: [{ id: "AC-001", text: "Return expected results", requirementIds: ["REQ-001"], verification: "Exercise search cases" }],
  }],
};
const body = (outcome: string) => ({
  outcome, summary: "Inspected search; delivery unverified.",
  coverage: [{ requirementId: "REQ-001", status: "addressed", evidence: "source.txt implements AC-001" }],
  findings: [], questions: [], checks: [{ description: "Run tests", outcome: "not_run", evidence: "Not run" }],
});
const write = (path: string, value: unknown) => writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));

/** A project with one waiting handoff, and a private Pi agent directory standing in for ~/.pi/agent. */
function project(t: TestContext, options: { mode?: "planning" | "testing"; user?: unknown; project?: unknown } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const root = join(base, "project"), agentDir = join(base, "agent");
  mkdirSync(join(root, ".pi"), { recursive: true });
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "source");
  if (options.user !== undefined) write(join(agentDir, "waicc-agents.json"), options.user);
  // The project file is source like any other, so it exists before the handoff is issued.
  if (options.project !== undefined) write(join(root, ".pi", "waicc-agents.json"), options.project);
  const s = createSession(root, "Add search");
  prepare(root, s.id, contract, "planning", "Inspect search", 0);
  if (options.mode === "testing") {
    submitRecipientReply(root, receiveHandoff(root, s.id).pin, body("planned"));
    const received = ingest(root, s.id);
    assess(root, s.id, { requestId: received.rounds.at(-1)!.id, decision: "planned", rationale: "Source checked", dispositions: [] });
    delegateWork(root, s.id, "testing", "Test everything");
  }
  return { root, agentDir, id: s.id };
}
const profiles = {
  claude: { via: "claude", model: "opus" },
  codex: { via: "codex", model: "gpt-5.5", timeoutMinutes: 45 },
  deepseek: { via: "pi", model: "deepseek/deepseek-v4-pro" },
};

test("the waiting handoff's role picks its profile, and typed settings override it", (t) => {
  const { root, id } = project(t, { user: { profiles, roles: { planning: "claude", review: "codex" } } });
  assert.deepEqual(resolveDispatch(root, id, ""), { options: { via: "claude", model: "opus" }, mode: "planning", profile: "claude", confirmChecks: false });
  assert.deepEqual(resolveDispatch(root, id, "codex").options, { via: "codex", model: "gpt-5.5", timeoutMinutes: 45 });
  assert.deepEqual(resolveDispatch(root, id, "codex --model gpt-6 --timeout 5").options, { via: "codex", model: "gpt-6", timeoutMinutes: 5 });
  assert.deepEqual(resolveDispatch(root, id, "--model sonnet").options, { via: "claude", model: "sonnet" }, "one setting overridden");
  assert.deepEqual(resolveDispatch(root, id, "--via pi").options, { via: "pi" }, "a typed agent needs no profile");
  assert.throws(() => resolveDispatch(root, id, "gemini"), /Unknown agent profile "gemini"\. Defined: claude, codex, deepseek/);
});

test("the project file wins over the user file, and nothing chosen names both files", (t) => {
  const none = project(t);
  assert.throws(() => resolveDispatch(none.root, none.id, ""), (error: Error) =>
    /No agent chosen for this planning handoff/.test(error.message) && error.message.includes(join(none.agentDir, "waicc-agents.json")) && error.message.includes(join(".pi", "waicc-agents.json")));
  const { root, id } = project(t, {
    user: { profiles, roles: { planning: "claude" } },
    project: { profiles: { claude: { via: "claude", model: "sonnet" } }, roles: { planning: "deepseek" } },
  });
  assert.deepEqual(resolveDispatch(root, id, "").options, { via: "pi", model: "deepseek/deepseek-v4-pro" }, "project role, user profile");
  assert.deepEqual(resolveDispatch(root, id, "claude").options, { via: "claude", model: "sonnet" }, "project profile replaces the user's");
  const view = profilesView(root);
  assert.equal(view.files.user.found && view.files.project.found, true);
  assert.equal((view.roles.review as string), "not set: pass --via or a profile name");
});

test("agent configs are validated strictly, and can never grant --implement", (t) => {
  const cases: [unknown, RegExp][] = [
    ["{ not json", /is not valid JSON/],
    [{ agents: {} }, /only "profiles", "roles", "autoContinue", "autoCompactTokens", "policies", "autoDecide", "autoAdvisor", "budget", "alerts", "sandbox", "gitlab" and "memory" are allowed/],
    [{ profiles: { x: { via: "gemini" } } }, /profile x: via must be one of claude, codex, pi, agy/],
    [{ profiles: { x: { via: "codex", implement: true } } }, /profile x allows only via, model, effort, timeoutMinutes and fallback/],
    [{ profiles: { "bad name": { via: "codex" } } }, /profile name "bad name"/],
    [{ profiles, roles: { coding: "codex" } }, /role "coding" must be one of planning, review, advisor, implementation, testing/],
    [{ profiles, roles: { implementation: { profile: "codex", implement: true } } }, /role implementation allows only profile, checks and checkTimeoutMinutes/],
    [{ profiles, roles: { review: "missing" } }, /Role review uses profile "missing", which no agent config defines/],
    [{ profiles: { x: { via: "codex", model: "bad model" } } }, /Invalid model name/],
  ];
  for (const [user, error] of cases) {
    const { root } = project(t, { user });
    assert.throws(() => loadAgentConfig(root), error);
  }
});

test("role checks fill in testing dispatches; only those from the project file need confirmation", (t) => {
  const roles = { testing: { profile: "claude", checks: ["npm test", "node --test 'tests/a b.ts'"], checkTimeoutMinutes: 5 } };
  const personal = project(t, { mode: "testing", user: { profiles, roles } });
  const mine = resolveDispatch(personal.root, personal.id, "");
  assert.equal(mine.confirmChecks, false);
  assert.deepEqual(mine.options.checks, [
    { program: "npm", args: ["test"], timeoutMs: 300_000 },
    { program: "node", args: ["--test", "tests/a b.ts"], timeoutMs: 300_000 },
  ]);
  assert.deepEqual(resolveDispatch(personal.root, personal.id, "codex").options.checks?.length, 2, "the role's checks, whichever profile runs it");
  assert.equal(resolveDispatch(personal.root, personal.id, "--check-timeout 20").options.checks?.[0].timeoutMs, 1_200_000);
  assert.deepEqual(resolveDispatch(personal.root, personal.id, '--check "npm run lint"').options.checks, [{ program: "npm", args: ["run", "lint"], timeoutMs: 600_000 }], "typed checks replace the role's");
  const shared = project(t, { mode: "testing", user: { profiles }, project: { roles } });
  assert.equal(resolveDispatch(shared.root, shared.id, "").confirmChecks, true);
  assert.equal(resolveDispatch(shared.root, shared.id, '--check "npm test"').confirmChecks, false, "commands you typed yourself");
});

test("/waicc-dispatch confirms project-file checks before anything runs, and lists profiles", async (t) => {
  const { root, id } = project(t, { mode: "testing", user: { profiles }, project: { roles: { testing: { profile: "claude", checks: ["npm test"] } } } });
  const harness = (confirm: boolean | null) => {
    const commands = new Map<string, any>(), shown: any[] = [], notices: string[] = [], entries: any[] = [], prompts: string[] = [];
    let ran = 0;
    waicc({
      registerCommand: (n: string, c: any) => commands.set(n, c), registerTool() {}, on() {},
      appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
      getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
      sendMessage: (m: any) => shown.push(m), sendUserMessage() {},
    } as unknown as ExtensionAPI, { runAgent: async () => (ran++, { stdout: "", stderr: "", code: 0, killed: false }) });
    const ctx = {
      cwd: root, mode: "tui", hasUI: confirm !== null, isIdle: () => true, isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => `chat-${confirm}`, getBranch: () => entries },
      ui: { notify: (m: string) => notices.push(m), confirm: async (title: string, message: string) => (prompts.push(`${title}\n${message}`), confirm) },
    } as unknown as ExtensionCommandContext;
    return { commands, shown, notices, prompts, ctx, ran: () => ran };
  };
  const listing = harness(true);
  await listing.commands.get("waicc-dispatch").handler("--profiles", listing.ctx);
  assert.equal(JSON.parse(listing.shown.at(-1).content).roles.testing.agent.via, "claude");

  const noUi = harness(null);
  await noUi.commands.get("waicc-use").handler(id, noUi.ctx);
  await noUi.commands.get("waicc-dispatch").handler("", noUi.ctx);
  assert.match(noUi.notices.at(-1)!, /needs interactive Pi/);

  const declined = harness(false);
  await declined.commands.get("waicc-use").handler(id, declined.ctx);
  await declined.commands.get("waicc-dispatch").handler("", declined.ctx);
  assert.match(declined.prompts[0], /npm test/);
  assert.match(declined.prompts[0], /anyone who can change the repository/);
  assert.match(declined.notices.at(-1)!, /checks were not approved/);
  assert.equal(declined.ran(), 0);
  assert.equal(loadSession(root, id).rounds.at(-1)!.status, "WAITING");

  const approved = harness(true);
  await approved.commands.get("waicc-use").handler(id, approved.ctx);
  await approved.commands.get("waicc-dispatch").handler("", approved.ctx);
  // The fake agent finishes at once, so find the start message rather than the last one.
  const started = approved.shown.map((m) => JSON.parse(m.content)).find((m) => m.dispatching);
  assert.equal(started.dispatching, true);
  assert.equal(started.profile, "claude");
});

test("the CLI lists profiles and needs --confirm-checks for project-file checks", (t) => {
  const { root, agentDir, id } = project(t, { mode: "testing", user: { profiles }, project: { roles: { testing: { profile: "claude", checks: ["npm test"] } } } });
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "--root", root, ...args], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  assert.equal(JSON.parse(cli("profiles").stdout).roles.testing.profile, "claude");
  const refused = cli("dispatch", id);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /npm test\. Review them, then add --confirm-checks/);
});

test("profiles set each agent's effort, typed --effort overrides it, and every agent's own levels are enforced", async (t) => {
  const { root, id } = project(t, {
    user: {
      profiles: {
        opus: { via: "claude", model: "claude-opus-5-5", effort: "medium" },
        sol: { via: "codex", model: "gpt-6.1-sol", effort: "medium" },
        deepseek: { via: "pi", model: "deepseek/deepseek-v4-pro", effort: "high" },
      },
      roles: { planning: "opus", review: "sol" },
    },
  });
  assert.deepEqual(resolveDispatch(root, id, "").options, { via: "claude", model: "claude-opus-5-5", effort: "medium" });
  assert.equal(resolveDispatch(root, id, "--effort low").options.effort, "low");
  // Each agent receives its own setting.
  const { prepareDispatch, runDispatch } = await import("../src/dispatch.ts");
  const flags: Record<string, string[]> = {
    opus: ["--effort", "medium"],
    sol: ["-c", 'model_reasoning_effort="medium"'],
    deepseek: ["--thinking", "high"],
  };
  for (const [name, expected] of Object.entries(flags)) {
    const plan = prepareDispatch(root, id, resolveDispatch(root, id, name).options);
    assert.ok(plan.args.some((arg, i) => arg === expected[0] && plan.args[i + 1] === expected[1]), `${name}: ${expected.join(" ")} in ${plan.args.join(" ")}`);
    assert.equal(plan.effort, expected[1].replace(/^model_reasoning_effort="(.*)"$/, "$1"));
    await runDispatch(plan, async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
  }
  const agy = prepareDispatch(root, id, { via: "agy", effort: "high" });
  assert.ok(agy.args.join(" ").includes("--effort high"));
  await runDispatch(agy, async () => ({ stdout: "", stderr: "", code: 0, killed: false }));
  assert.throws(() => prepareDispatch(root, id, { via: "claude", effort: "ultra" }), /effort for claude must be one of low, medium, high, xhigh, max/);
  assert.throws(() => resolveDispatch(root, id, "--effort LOUD"), /Invalid effort level/);
  const bad = project(t, { user: { profiles: { x: { via: "agy", effort: "ultra" } } } });
  assert.throws(() => loadAgentConfig(bad.root), /profile x: effort for agy must be one of low, medium, high, xhigh, max/);
});

test("the shipped template is a valid default for every role, and init never replaces a file", async (t) => {
  const { root, agentDir, id } = project(t);
  assert.throws(() => resolveDispatch(root, id, ""), /--init-profiles \(CLI: waicc profiles init\)/);
  const { initAgentConfig, templateConfigPath } = await import("../src/profiles.ts");
  const created = initAgentConfig();
  assert.equal(created.created, true);
  assert.equal(created.path, join(agentDir, "waicc-agents.json"));
  assert.equal(readFileSync(created.path, "utf8"), readFileSync(templateConfigPath(), "utf8"));
  const config = loadAgentConfig(root);
  assert.deepEqual(Object.keys(config.roles).sort(), ["advisor", "implementation", "planning", "review", "testing"]);
  assert.equal(resolveDispatch(root, id, "").options.via, "claude", "planning works straight from the template");

  writeFileSync(created.path, JSON.stringify({ profiles: { mine: { via: "pi" } }, roles: { planning: "mine" } }));
  const again = initAgentConfig();
  assert.equal(again.created, false);
  assert.match(readFileSync(created.path, "utf8"), /"mine"/, "an existing file is left unchanged");

  const cli = spawnSync(process.execPath, [resolve("src/cli.ts"), "--root", root, "profiles", "init"], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  assert.equal(JSON.parse(cli.stdout).created, false);
});

test("the default template carries the full profile set: role defaults plus variants picked by name", async (t) => {
  const { templateConfigPath } = await import("../src/profiles.ts");
  const { root, id } = project(t, { user: readFileSync(templateConfigPath(), "utf8") });
  const config = loadAgentConfig(root);
  assert.deepEqual(Object.keys(config.profiles), ["opus", "opus-max", "sonnet", "haiku", "sol", "sol-ultra", "codex", "luna", "deepseek", "flash"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(config.roles).map(([role, choice]) => [role, choice!.profile])),
    { planning: "opus", review: "sol", implementation: "codex", testing: "deepseek", advisor: "sonnet" },
  );
  assert.deepEqual(resolveDispatch(root, id, "opus-max").options, { via: "claude", model: "claude-opus-5-5", effort: "max" });
});

test("autoContinue comes only from your user file; --continue and --no-continue win, and a loop always continues", (t) => {
  const mine = project(t, { user: { autoContinue: true, profiles, roles: { planning: "claude" } } });
  assert.equal(resolveDispatch(mine.root, mine.id, "").options.continue, true);
  assert.equal(resolveDispatch(mine.root, mine.id, "--via pi").options.continue, true, "also with a typed agent");
  assert.equal(resolveDispatch(mine.root, mine.id, "--no-continue").options.continue, false);
  assert.equal(profilesView(mine.root).autoContinue, true);
  const off = project(t, { user: { profiles, roles: { planning: "claude" } } });
  assert.equal(resolveDispatch(off.root, off.id, "").options.continue, undefined);
  assert.equal(resolveDispatch(off.root, off.id, "--continue").options.continue, true);
  assert.deepEqual(resolveDispatch(off.root, off.id, "--loop 2").options, { via: "claude", model: "opus", loop: 2, continue: true });
  assert.equal(resolveDispatch(off.root, off.id, "--loop").options.loop, 3);
  assert.throws(() => resolveDispatch(off.root, off.id, "--loop 99"), /--loop takes 1–8 cycles/);
  const shared = project(t, { project: { autoContinue: true } });
  assert.throws(() => loadAgentConfig(shared.root), /"autoContinue" is allowed only in your user file/);
  const typo = project(t, { user: { autoContinue: "yes" } });
  assert.throws(() => loadAgentConfig(typo.root), /"autoContinue" must be true or false/);
});

test("the CLI's --continue validates the reply, and --loop is refused outside Pi", (t) => {
  const { root, agentDir, id } = project(t, { user: { profiles, roles: { planning: "claude" } } });
  const cli = (...args: string[]) => spawnSync(process.execPath, [resolve("src/cli.ts"), "--root", root, ...args], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  const looped = cli("dispatch", id, "--loop");
  assert.equal(looped.status, 1);
  assert.match(looped.stderr, /--loop needs the main agent in Pi/);
});

test("-c is short for --continue", (t) => {
  const { root, id } = project(t, { user: { profiles, roles: { planning: "claude" } } });
  assert.equal(resolveDispatch(root, id, "-c").options.continue, true);
  assert.deepEqual(resolveDispatch(root, id, "codex -c").options, { via: "codex", model: "gpt-5.5", timeoutMinutes: 45, continue: true });
});

test("--auto is --loop 3 --develop --review, and --plan-with and --review-with choose each stage's profile", (t) => {
  const { root, id } = project(t, { user: { profiles: { ...profiles, opus: { via: "claude", model: "opus" } }, roles: { planning: "opus", review: "codex" } } });
  const auto = resolveDispatch(root, id, "--auto");
  assert.deepEqual([auto.profile, auto.options.loop, auto.options.develop, auto.options.review, auto.options.continue], ["opus", 3, true, true, true]);
  assert.equal(resolveDispatch(root, id, "--auto --loop 5").options.loop, 5, "a typed --loop keeps its count");
  const chosen = resolveDispatch(root, id, "--auto --plan-with deepseek --review-with claude");
  assert.deepEqual([chosen.profile, chosen.options.via, chosen.options.reviewWith], ["deepseek", "pi", "claude"]);
  assert.equal(resolveDispatch(root, id, "deepseek --auto").profile, "deepseek", "naming it first still works");
  assert.throws(() => resolveDispatch(root, id, "codex --plan-with deepseek"), /Give the planning profile once/);
  assert.throws(() => resolveDispatch(root, id, "--plan-with nope --auto"), /Unknown agent profile "nope"/);
});

test("--code-with takes an optional coding profile and --review-once needs a reviewed automatic run", (t) => {
  const { root, id } = project(t, { user: { profiles: { ...profiles, agy: { via: "agy", model: "gemini-3-pro" } }, roles: { planning: "claude", implementation: "codex" } } });
  assert.equal(resolveDispatch(root, id, "--auto --code-with deepseek").options.codeWith, "deepseek");
  const plain = resolveDispatch(root, id, "--auto --code-with --review-once");
  assert.deepEqual([plain.options.codeWith, plain.options.reviewOnce, plain.options.review], [true, true, true]);
  assert.throws(() => resolveDispatch(root, id, "--code-with codex"), /needs --auto or --develop/);
  assert.throws(() => resolveDispatch(root, id, "--develop --review-once"), /--review-once stops an automatic run/);
  assert.deepEqual(codingAgent(root), { profile: "codex", via: "codex", model: "gpt-5.5" }, "the implementation role codes by default");
  assert.equal(codingAgent(root, "deepseek").via, "pi");
  assert.throws(() => codingAgent(root, "nope"), /No agent profile named "nope"/);
  assert.throws(() => codingAgent(root, "agy"), /Antigravity, which cannot code yet/);
  const unset = project(t, { user: { profiles, roles: { planning: "claude" } } });
  assert.throws(() => codingAgent(unset.root), /--code-with needs a coding agent/);
});
