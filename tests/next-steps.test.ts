import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { assess, beginDevelopment, createSession, delegateWork, ingest, issue, prepare, status } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const contract: Contract = {
  title: "Menu", requirements: [{ id: "R1", text: "Add a menu", sourceQuote: "Add a menu" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title: "Menu", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"],
    acceptance: [{ id: "AC1", text: "Opens", requirementIds: ["R1"], verification: "Open it" }] }],
};

function project(t: TestContext, user?: object) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const agentDir = join(base, "agent"), root = join(base, "app");
  mkdirSync(agentDir);
  mkdirSync(root);
  writeFileSync(join(root, "app.txt"), "app");
  if (user) writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify(user));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  return root;
}

test("a waiting handoff's next steps are a short table: headless with the role's agent, by hand, then continue", (t) => {
  const root = project(t, { profiles: { opus: { via: "claude", model: "claude-opus-5-5" }, codex: { via: "codex" } }, roles: { planning: "opus", implementation: "codex" } });
  const s = createSession(root, "Add a menu");
  prepare(root, s.id, contract, "planning", "Plan", 0);
  const view = status(root, s.id) as any;
  assert.deepEqual(view.nextSteps, [
    { step: "Send it to an agent, headless", command: "/waicc-dispatch --continue", detail: "your opus profile (claude claude-opus-5-5); the main agent assesses its reply as soon as it arrives" },
    { step: "Or give it to an agent yourself", command: "/waicc-handoff", detail: "shows the prompt to paste, and copies it" },
    { step: "Only if nothing continued by itself", command: "/waicc-continue", detail: "checks and assesses the reply; a headless run with --continue does this for you" },
  ]);
  assert.match(view.nextAction, /Show the human nextSteps as a short table/);
  assert.match(view.nextAction, /Do not paste the handoff prompt into the chat/);

  // A coding handoff needs --implement to be sent headless.
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "planned", summary: "Plan", questions: [], findings: [],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
    checks: [{ description: "Read app.txt", outcome: "passed", evidence: "Inspected" }],
  });
  assess(root, s.id, { requestId: ingest(root, s.id).rounds.at(-1)!.id, decision: "planned", rationale: "Sound", dispositions: [] });
  beginDevelopment(root, s.id, "delegate");
  delegateWork(root, s.id, "implementation", "Build it");
  assert.equal((status(root, s.id) as any).nextSteps[0].command, "/waicc-dispatch --implement --continue");
});

test("with no agent set for the role, the table says how to pick one; with nothing waiting there is no table", (t) => {
  const root = project(t, { profiles: {}, roles: {} });
  const s = createSession(root, "Add a menu");
  assert.equal((status(root, s.id) as any).nextSteps, null);
  prepare(root, s.id, contract, "planning", "Plan", 0);
  assert.deepEqual((status(root, s.id) as any).nextSteps[0], {
    step: "Send it to an agent, headless", command: "/waicc-dispatch --via <claude|codex|pi|agy> --continue",
    detail: "no agent is set for this role yet; /waicc-dispatch --profiles shows your profiles",
  });
});

test("with autoContinue on the command needs no flag; a code review the main agent may fix offers the review loop first", (t) => {
  const root = project(t, { autoContinue: true, profiles: { opus: { via: "claude" } }, roles: { planning: "opus", review: "opus" } });
  const s = createSession(root, "Add a menu");
  prepare(root, s.id, contract, "planning", "Plan", 0);
  const steps = (status(root, s.id) as any).nextSteps;
  assert.equal(steps[0].command, "/waicc-dispatch");
  assert.equal(steps.at(-1).detail, "checks and assesses the reply");
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "planned", summary: "Plan", questions: [], findings: [],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
    checks: [{ description: "Read app.txt", outcome: "passed", evidence: "Inspected" }],
  });
  assess(root, s.id, { requestId: ingest(root, s.id).rounds.at(-1)!.id, decision: "planned", rationale: "Sound", dispositions: [] });
  beginDevelopment(root, s.id, "main");
  writeFileSync(join(root, "app.txt"), "app with a menu");
  issue(root, s.id, "review", "Review it", undefined, undefined, { kind: "code", completion: {
    summary: "Done", tasks: [{ taskId: "T1", evidence: "app.txt has the menu" }],
    checks: [{ description: "Open it", outcome: "passed", evidence: "Opened" }], findings: [] } });
  const review = (status(root, s.id) as any).nextSteps;
  assert.deepEqual(review.map((row: any) => row.command), ["/waicc-dispatch --loop", "/waicc-dispatch", "/waicc-handoff", "/waicc-continue"]);
  assert.match(review[0].detail, /^claude; at most 3 cycles, stops on a pass, a blocker or a decision; never closes$/);
  assert.equal(review[1].step, "Or one review only, headless");
});
