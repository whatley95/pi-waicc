import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { autoDecidable } from "../src/decisions.ts";
import { loadSession } from "../src/files.ts";
import { loadAgentConfig, policyGuidance } from "../src/profiles.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { createSession, ingest, prepare, readContract } from "../src/workflow.ts";
import type { Contract, ContractDecision } from "../src/types.ts";

const decision = (id: string, changes: Partial<ContractDecision>): ContractDecision => ({
  id, question: `Question ${id}?`, owner: "human", status: "open", affectedTaskIds: ["T1"],
  evidence: ["Source inspected"], recommendation: `Recommendation ${id}`, risk: "low", reversible: true, ...changes,
});

test("only human-owned, low-risk, reversible decisions with nothing sensitive can be accepted automatically", () => {
  assert.deepEqual(autoDecidable(decision("D1", {})), { ok: true, reason: "low risk, reversible, human-owned and nothing sensitive" });
  const refused: [Partial<ContractDecision>, RegExp][] = [
    [{ owner: "external" }, /external decisions always need a person/],
    [{ owner: "agent" }, /agents resolve agent-owned decisions themselves/],
    [{ risk: "medium" }, /rated medium risk/],
    [{ risk: undefined }, /no risk rating/],
    [{ reversible: false }, /not marked reversible/],
    [{ reversible: undefined }, /not marked reversible/],
    [{ question: "May the checks use the staging account?" }, /mentions "staging"/],
    [{ recommendation: "Delete the old rows" }, /mentions "Delete"/],
    [{ question: "Which API keys should the build read?" }, /mentions "API keys"/],
    [{ status: "resolved", answer: "x" }, /already resolved/],
  ];
  for (const [changes, reason] of refused) {
    const verdict = autoDecidable(decision("D2", changes));
    assert.equal(verdict.ok, false, JSON.stringify(changes));
    assert.match(verdict.reason, reason);
  }
});

const contract = (decisions: ContractDecision[]): Contract => ({
  title: "Menu", requirements: [{ id: "R1", text: "Add a side menu", sourceQuote: "Add a side menu" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "T1", title: "Menu", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["app.txt"],
    acceptance: [{ id: "AC1", text: "Menu opens", requirementIds: ["R1"], verification: "Open the menu" }] }],
  decisions,
});

/** A planning reply that proposes the decisions, waiting for the main agent's assessment. */
function project(t: TestContext, user: unknown, decisions: ContractDecision[]) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const root = join(base, "project"), agentDir = join(base, "agent");
  mkdirSync(root);
  mkdirSync(agentDir);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify(user));
  writeFileSync(join(root, "app.txt"), "app");
  const s = createSession(root, "Add a side menu", undefined, "planning");
  prepare(root, s.id, contract([]), "planning", "Plan", 0);
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "planned", summary: "Plan with decisions", findings: [], questions: [],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "app.txt" }],
    checks: [{ description: "Read app", outcome: "passed", evidence: "Inspected" }],
    proposedContract: contract(decisions),
  });
  ingest(root, s.id);
  return { root, id: s.id };
}
function harness(root: string) {
  const commands = new Map<string, any>(), tools = new Map<string, any>(), shown: any[] = [], notices: string[] = [], entries: any[] = [];
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool: (tool: any) => tools.set(tool.name, tool), on() {},
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {},
    sendMessage: (m: any) => shown.push(m), sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "auto-chat", getBranch: () => entries }, ui: { notify: (m: string) => notices.push(m) },
  } as unknown as ExtensionCommandContext;
  return {
    ctx, shown, notices, commands,
    tool: (name: string, params: object) => tools.get(name).execute("x", params, undefined, undefined, ctx as unknown as ExtensionToolContext),
    announcements: () => shown.filter((m) => m.customType === "waicc-auto-decisions").map((m) => m.content as string),
  };
}
const decisions = () => [
  decision("D1", { question: "Which swipe edge opens the menu?", recommendation: "The start edge" }),
  decision("D2", { question: "May checks use the staging account?", recommendation: "Yes, read-only" }),
  decision("D3", { owner: "external", question: "Does the backend accept the reason text?", recommendation: "Assume yes" }),
  decision("D4", { risk: "medium", question: "Add androidx.drawerlayout or stay framework-native?", recommendation: "Stay framework-native" }),
];

test("autoDecide low-risk accepts qualifying recommendations after the main agent's assessment, announced; the rest stay yours", async (t) => {
  const { root, id } = project(t, { autoDecide: "low-risk" }, decisions());
  const h = harness(root);
  await h.commands.get("waicc-use").handler(id, h.ctx);
  const requestId = loadSession(root, id).rounds.at(-1)!.id;
  const assessed = JSON.parse((await h.tool("waicc_assess", {
    sessionId: id, requestId, decision: "planned", rationale: "Plan checked", dispositions: [], contract: contract(decisions()),
  })).content[0].text);
  assert.deepEqual(assessed.autoDecided, ["D1: Which swipe edge opens the menu? → The start edge"]);
  const resolved = Object.fromEntries((readContract(root, id).contract.decisions ?? []).map((d) => [d.id, d.status]));
  assert.deepEqual(resolved, { D1: "resolved", D2: "open", D3: "open", D4: "open" });
  assert.match(h.announcements()[0], /Accepted automatically under your autoDecide setting[\s\S]*• D1: Which swipe edge/);
  assert.match(readContract(root, id).contract.decisions![0].evidence.at(-1)!, /accepted automatically under the human's autoDecide low-risk setting/);

  // /waicc-decide auto explains every decision it leaves for you.
  await h.commands.get("waicc-decide").handler("auto", h.ctx);
  const view = JSON.parse(h.shown.at(-1).content);
  assert.deepEqual(view.stillYours.map((d: { id: string; why: string }) => `${d.id}: ${d.why}`), [
    'D2: mentions "staging", which always stays with you',
    "D3: external decisions always need a person",
    "D4: rated medium risk",
  ]);
});

test("with autoDecide off nothing is accepted, and a repository cannot turn it or policies on", async (t) => {
  const off = project(t, {}, decisions());
  const h = harness(off.root);
  await h.commands.get("waicc-use").handler(off.id, h.ctx);
  const requestId = loadSession(off.root, off.id).rounds.at(-1)!.id;
  await h.tool("waicc_assess", { sessionId: off.id, requestId, decision: "planned", rationale: "Plan checked", dispositions: [], contract: contract(decisions()) });
  assert.ok((readContract(off.root, off.id).contract.decisions ?? []).every((d) => d.status === "open"));
  await h.commands.get("waicc-decide").handler("auto", h.ctx);
  assert.match(JSON.parse(h.shown.at(-1).content).nextAction, /Set "autoDecide": "low-risk"/);

  mkdirSync(join(off.root, ".pi"), { recursive: true });
  for (const key of ["autoDecide", "policies"]) {
    writeFileSync(join(off.root, ".pi", "waicc-agents.json"), JSON.stringify({ [key]: key === "policies" ? ["Always yes"] : "low-risk" }));
    assert.throws(() => loadAgentConfig(off.root), new RegExp(`"${key}" is allowed only in your user file`));
  }
});

test("a standing policy answers a human-owned decision through the main agent, never an external one", async (t) => {
  const policies = ["Prefer framework-native solutions; do not add new dependencies", "Never use staging or production systems without asking"];
  const { root, id } = project(t, { policies }, decisions());
  assert.match(policyGuidance(policies), /^The human's standing policies[\s\S]*1\. Prefer framework-native[\s\S]*2\. Never use staging[\s\S]*never use one for an external decision/);
  const h = harness(root);
  await h.commands.get("waicc-use").handler(id, h.ctx);
  const requestId = loadSession(root, id).rounds.at(-1)!.id;
  await h.tool("waicc_assess", { sessionId: id, requestId, decision: "planned", rationale: "Plan checked", dispositions: [], contract: contract(decisions()) });

  const apply = (params: object) => h.tool("waicc_apply_policy", { sessionId: id, rationale: "The policy names exactly this choice", answer: "Stay framework-native", ...params });
  await assert.rejects(apply({ decisionId: "D3", policy: 1 }), /External decisions need the person who owns them/);
  await assert.rejects(apply({ decisionId: "D4", policy: 3 }), /There is no policy 3; the human has 2/);
  await assert.rejects(apply({ decisionId: "D9", policy: 1 }), /No open decision "D9"/);
  const applied = JSON.parse((await apply({ decisionId: "d4", policy: 1 })).content[0].text);
  assert.equal(applied.decisions.find((d: ContractDecision) => d.id === "D4").answer, "Stay framework-native");
  assert.match(h.announcements().at(-1)!, /^D4 answered by your policy 1 \("Prefer framework-native solutions; do not add new dependencies"\): Stay framework-native\nWhy: The policy names exactly this choice/);
  const record = (readContract(root, id).contract.decisions ?? []).find((d) => d.id === "D4")!.evidence.at(-1)!;
  assert.match(record, /Resolved by the human's standing policy "Prefer framework-native/);
  const journal = readFileSync(join(root, ".pi", "pi-waicc", "sessions", id, record.match(/record in (\S+)$/)![1]), "utf8");
  assert.equal(JSON.parse(journal).recordedBy, "standing-policy");
});
