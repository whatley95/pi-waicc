import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { loadSession } from "../src/files.ts";
import { loadAgentConfig, profilesView, resolveDispatch } from "../src/profiles.ts";
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
    [{ agents: {} }, /only "profiles" and "roles" are allowed/],
    [{ profiles: { x: { via: "gemini" } } }, /profile x: via must be one of claude, codex, pi, agy/],
    [{ profiles: { x: { via: "codex", implement: true } } }, /profile x allows only via, model and timeoutMinutes/],
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
