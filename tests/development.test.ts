import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { artifact, commit as journalCommit, loadSession, sessionRelative } from "../src/files.ts";
import { checkpointView } from "../src/checkpoint.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { reviewKindLabel } from "../src/state.ts";
import { amend, assess, beginDevelopment, cancel, closeSession, createSession, decisionsView, delegateWork, exportHandoff,
  forceCloseSession, ingest, issue, prepare, readContract, reopenSession, resolveDecision, setRoundLimit, status } from "../src/workflow.ts";
import type { Contract, Reply, Round, Session, WorkCompletion } from "../src/types.ts";
import { readyPlan, relativePath, text, validateContract } from "../src/validation.ts";
import { chatJson, modelLimit, modelView } from "../src/pi/app.ts";

const contract: Contract = {
  title: "Account search", requirements: [{ id: "R1", text: "Account search", sourceQuote: "Add account search" }],
  exclusions: ["Deployment"], assumptions: [], risks: [], questions: [], skills: [],
  tasks: ["A", "B"].map((id, i) => ({ id, title: `Search work ${id}`, requirementIds: ["R1"], dependsOn: i ? ["A"] : [],
    allowedPaths: [i ? "other.txt" : "app.txt"], acceptance: [{ id: `AC${id}`, text: "Account isolation", requirementIds: ["R1"], verification: "Run isolation checks" }] })),
};
function fixture(t: TestContext, spec = false, gated = false, modern = true) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-development-")));
  t.after(() => { assert.ok(basename(root).startsWith("waicc-development-")); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "app.txt"), "original"); writeFileSync(join(root, "other.txt"), "original");
  let s = createSession(root, "Add account search", undefined, modern ? "planning" : undefined);
  const c = structuredClone(contract);
  if (gated) c.decisions = [{ id: "D1", question: "Which backend policy?", owner: "external", status: "open", affectedTaskIds: ["B"],
    evidence: ["Backend owner confirmation unavailable in source"], recommendation: "Retain existing account-isolation policy" }];
  s = prepare(root, s.id, c, spec ? "review" : "planning", "Inspect full scope", 0, spec ? { kind: "contract" } : undefined);
  return { root, s: loadSession(root, s.id) };
}
function answer(root: string, s: Session, changes: Partial<Reply> = {}) {
  const a = receiveHandoff(root, s.id, s.rounds.at(-1)!.mode === "implementation");
  submitRecipientReply(root, a.pin, { outcome: a.pin.mode === "planning" ? "planned" : "ready", summary: "Source-backed fixture assessment; no production claim",
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "AC mappings and source examined" }],
    findings: [], questions: [], checks: [{ description: "Runtime", outcome: "not_run", evidence: "Fixture source inspection only" }], ...changes });
  return ingest(root, s.id);
}
function accept(root: string, s: Session, decision: "ready" | "planned" | "needs_changes" = "ready") {
  return assess(root, s.id, { requestId: s.rounds.at(-1)!.id, decision, rationale: "Fixture source-backed evidence assessed", dispositions: [] });
}
function report(): WorkCompletion { return { summary: "All task completion reported for independent review", tasks: contract.tasks.map((t) => ({ taskId: t.id, evidence: `${t.allowedPaths[0]} implements ${t.acceptance[0].id}` })),
  checks: [{ description: "Runtime", outcome: "not_run", evidence: "Unavailable in this fixture" }], findings: [] }; }

test("specification PASS without planApproval can explicitly become development in the same session", (t) => {
  for (const modern of [true, false]) {
    const { root, s: initial } = fixture(t, true, false, modern);
    let s = accept(root, answer(root, initial));
    assert.equal(s.status, modern ? "SPEC_APPROVED" : "READY_TO_CLOSE");
    const before = status(root, s.id) as any;
    assert.equal(before.planAccepted, false); assert.equal(before.implementationAuthorized, false);
    assert.equal(before.specificationReview.status, "PASS"); assert.equal(before.codeReview.status, "NOT_REVIEWED");
    assert.equal(before.progress.reportedCompleteTasks, null);
    const version = s.contractVersion, rounds = s.rounds.length, limit = s.maxRounds;
    s = beginDevelopment(root, s.id);
    assert.equal(s.id, initial.id); assert.equal(s.contractVersion, version); assert.equal(s.rounds.length, rounds); assert.equal(s.maxRounds, limit);
    assert.equal(s.status, "READY_TO_IMPLEMENT"); assert.equal(s.objective, "development");
    const view = status(root, s.id) as any;
    assert.equal(view.planAccepted, true); assert.equal(view.implementationAuthorized, true); assert.equal(view.executionReady, true);
    assert.equal(view.progress.reportedCompleteTasks, null); assert.equal(view.deliveryVerified, false);
    assert.ok(artifact(root, s, s.implementationAuthorization!.artifactPath).includes("human-develop"));
    assert.equal(readFileSync(join(root, "app.txt"), "utf8"), "original");
    assert.deepEqual(beginDevelopment(root, s.id), loadSession(root, s.id)); // Repeating the command is not another round/grant.
    assert.throws(() => closeSession(root, s.id, "Spec is not finished development"), /READY_TO_CLOSE/);
  }
});

test("plan acceptance is distinct from authority; gate answers preserve scope/history and explicitly repin an existing grant", (t) => {
  const { root, s: initial } = fixture(t, false, true);
  let s = accept(root, answer(root, initial), "planned");
  assert.equal((status(root, s.id) as any).implementationAuthorized, false);
  s = beginDevelopment(root, s.id);
  assert.equal(s.status, "IMPLEMENTATION_GATED");
  let view = status(root, s.id) as any;
  assert.equal(view.implementationAuthorized, true); assert.equal(view.executionReady, false); assert.equal(view.openGates, 1);
  assert.deepEqual(view.decisionGates.decisionUnblockedTaskIds, ["A"]);
  const before = loadSession(root, s.id);
  assert.throws(() => delegateWork(root, s.id, "implementation", "Do the entire plan"), /gated/);
  assert.deepEqual(loadSession(root, s.id), before);
  const brief = decisionsView(root, s.id);
  assert.equal(brief.pendingDecisions[0].recommendation, "Retain existing account-isolation policy");
  assert.ok(readFileSync(brief.briefPath!, "utf8").includes("D1"));
  const oldContract = readContract(root, s.id), originalRequirements = [...s.requirements], roundCount = s.rounds.length;
  s = resolveDecision(root, s.id, "D1", "Retain existing policy; backend owner confirmed compatibility");
  assert.equal(s.contractVersion, oldContract.version + 1); assert.equal(s.rounds.length, roundCount);
  assert.deepEqual(s.requirements, originalRequirements); assert.equal(s.status, "READY_TO_IMPLEMENT");
  assert.equal(s.contractReview, "NOT_REVIEWED"); assert.equal(s.reviewApproval, undefined);
  assert.equal(s.implementationAuthorization!.origin, "human-decision-resolution");
  const updated = readContract(root, s.id);
  assert.deepEqual(updated.contract.tasks, oldContract.contract.tasks); assert.deepEqual(updated.contract.requirements, oldContract.contract.requirements);
  assert.equal(updated.contract.decisions![0].status, "resolved");
  assert.ok(artifact(root, s, "contracts/v001/contract.json").includes('"status": "open"'));
  view = status(root, s.id) as any;
  assert.equal(view.implementationAuthorized, true); assert.equal(view.openGates, 0);
  s = issue(root, s.id, "review", "Review all implemented code", undefined, undefined, { kind: "code", completion: report() });
  s = accept(root, answer(root, s));
  assert.equal(s.status, "READY_TO_CLOSE"); assert.equal(s.reviewApproval!.kind, "code");
  assert.equal(closeSession(root, s.id, "Whole-change evidence accepted").status, "CLOSED");
});

test("drafts, pending replies, stale specification PASS and scope revisions cannot silently authorize work", (t) => {
  const { root, s: initial } = fixture(t, true);
  assert.throws(() => beginDevelopment(root, initial.id), /pending handoff/);
  let s = cancel(root, initial.id);
  assert.throws(() => beginDevelopment(root, s.id), /Accept the current/);
  s = issue(root, s.id, "review", "Full specification", undefined, undefined, { kind: "contract" });
  s = accept(root, answer(root, s));
  writeFileSync(join(root, "app.txt"), "changed");
  assert.throws(() => beginDevelopment(root, s.id), /fresh specification PASS/);
  assert.equal((status(root, s.id) as any).status, "STALE");
  writeFileSync(join(root, "app.txt"), "original");
  s = beginDevelopment(root, s.id);
  s = prepare(root, s.id, { ...contract, risks: ["New investigation needs acceptance"] }, "planning", "Reassess revision", s.contractVersion);
  cancel(root, s.id);
  assert.equal((status(root, s.id) as any).implementationAuthorized, false);
  assert.throws(() => beginDevelopment(root, s.id), /Accept the current/);
  amend(root, s.id, "Also document the API");
  assert.throws(() => beginDevelopment(root, s.id), /Requirements changed/);
});

test("decision answering rejects unknown/pending/conflicting/closed changes and never grants authority to planning-only work", (t) => {
  const { root, s: initial } = fixture(t, true, true);
  assert.throws(() => resolveDecision(root, initial.id, "D1", "answer"), /pending handoff/);
  let s = accept(root, answer(root, initial));
  assert.throws(() => resolveDecision(root, s.id, "missing", "answer"), /Unknown decision/);
  assert.throws(() => resolveDecision(root, s.id, "D1", ""), /nonempty/);
  s = resolveDecision(root, s.id, "D1", "Keep policy");
  assert.equal(s.status, "PLAN_READY"); assert.equal((status(root, s.id) as any).implementationAuthorized, false);
  assert.deepEqual(resolveDecision(root, s.id, "D1", "Keep policy"), s);
  assert.throws(() => resolveDecision(root, s.id, "D1", "Change policy"), /already resolved/);
  s = beginDevelopment(root, s.id);
  s = forceCloseSession(root, s.id);
  assert.throws(() => resolveDecision(root, s.id, "D1", "Keep policy"), /closed/);
  assert.equal((status(root, s.id) as any).implementationAuthorized, false);
  s = reopenSession(root, s.id, "Resume development intentionally");
  assert.equal(s.implementationAuthorization, undefined);
  assert.equal((status(root, s.id) as any).implementationAuthorized, false);
});

test("new phase budgets remain bounded by the unchanged overall budget; transitions and answers do not consume rounds", (t) => {
  const { root, s: initial } = fixture(t);
  assert.equal(initial.maxRounds, 20);
  assert.equal(initial.roundLimits!.specification, 8);
  let s = cancel(root, initial.id);
  s = setRoundLimit(root, s.id, 2, "specification");
  s = issue(root, s.id, "planning", "Second planning round");
  s = accept(root, answer(root, s), "planned");
  const before = loadSession(root, s.id), usage = (status(root, s.id) as any).roundBudget;
  assert.equal(usage.phases.specification.used, 2); assert.equal(usage.phases.code_review.used, 0);
  assert.throws(() => issue(root, s.id, "review", "No more specification rounds", undefined, undefined, { kind: "contract" }), /specification phase limit/);
  assert.deepEqual(loadSession(root, s.id), before);
  s = beginDevelopment(root, s.id);
  assert.equal(s.rounds.length, 2); assert.equal(s.roundLimits!.specification, 2); assert.equal(s.maxRounds, 20);
  s = setRoundLimit(root, s.id, 2);
  assert.throws(() => issue(root, s.id, "review", "Overall budget still enforced", undefined, undefined, { kind: "code", completion: report() }), /2-round limit/);
  s = setRoundLimit(root, s.id, 3);
  s = issue(root, s.id, "review", "Independent code review", undefined, undefined, { kind: "code", completion: report() });
  assert.equal(s.rounds.at(-1)!.phase, "code_review");
  assert.equal((status(root, s.id) as any).roundBudget.phases.code_review.used, 1);
});

test("reported task progress is source/version labelled and never inferred from specification PASS", (t) => {
  const { root, s: initial } = fixture(t);
  let s = accept(root, answer(root, initial), "planned");
  s = beginDevelopment(root, s.id);
  assert.equal((status(root, s.id) as any).progress.reportedCompleteTasks, null);
  s = issue(root, s.id, "review", "Inspect reported full implementation", undefined, undefined, { kind: "code", completion: report() });
  assert.equal((status(root, s.id) as any).progress.reportedCompleteTasks, 2);
  writeFileSync(join(root, "other.txt"), "new code");
  assert.equal((status(root, s.id) as any).progress.reportedCompleteTasks, null);
  assert.equal((status(root, s.id) as any).progress.reportMatchesCurrentSource, false);
  assert.equal((status(root, s.id) as any).deliveryVerified, false);
});

test("checkpoint/export retains human authorization and decision audit originals; legacy review labels are explicit", (t) => {
  const { root, s: initial } = fixture(t, true, true);
  let s = beginDevelopment(root, accept(root, answer(root, initial)).id);
  s = resolveDecision(root, s.id, "D1", "Keep policy");
  const recovery = checkpointView(root, s);
  assert.ok(recovery.brief.includes("Implementation authorized: true"));
  s = issue(root, s.id, "review", "Whole change", undefined, undefined, { kind: "code", completion: report() });
  const exported = exportHandoff(root, s.id);
  const index = JSON.parse(readFileSync(join(exported, "checkpoint.json"), "utf8"));
  assert.equal(index.objective, "development"); assert.equal(index.implementationAuthorization.authorized, true);
  assert.ok(index.artifacts.some((a: any) => a.path.startsWith("decisions/")));
  assert.ok(index.artifacts.some((a: any) => a.path === s.implementationAuthorization!.artifactPath));
  assert.equal(readFileSync(join(exported, "archive", s.implementationAuthorization!.artifactPath), "utf8"), artifact(root, s, s.implementationAuthorization!.artifactPath));
  assert.equal(reviewKindLabel({ mode: "review" } as Round), "legacy_contract");
  assert.equal(reviewKindLabel({ mode: "review", review: { kind: "unexpected" } } as unknown as Round), "unknown");
});

function harness(root: string) {
  const commands = new Map<string, any>(), hooks = new Map<string, any>(), tools = new Map<string, any>();
  const shown: any[] = [], prompts: string[] = [], notices: string[] = [];
  waicc({ registerCommand: (n: string, c: any) => commands.set(n, c), registerTool: (v: any) => tools.set(v.name, v), on: (n: string, h: any) => hooks.set(n, h),
    appendEntry() {}, sendMessage: (m: any) => shown.push(JSON.parse(m.content)), sendUserMessage: (m: string) => prompts.push(m),
    getActiveTools: () => ["read", "edit", "write", "bash", "waicc_status", "waicc_reply"],
    getAllTools: () => ["read", "edit", "write", "bash", "waicc_status", "waicc_reply"].map((name) => ({ name })), setActiveTools() {},
  } as unknown as ExtensionAPI, { copyText: async () => {} });
  const ctx = { cwd: root, mode: "json", isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "development-chat" }, ui: { notify: (m: string) => notices.push(m) } } as unknown as ExtensionCommandContext;
  return { commands, hooks, tools, shown, prompts, notices, ctx };
}
test("Pi commands authorize only through human transitions, show decisions without inference and keep recipient/coordinator roles distinct", async (t) => {
  const { root, s: initial } = fixture(t, true, true), h = harness(root);
  let s = accept(root, answer(root, initial));
  await h.commands.get("waicc-use").handler(s.id, h.ctx);
  assert.equal((await h.hooks.get("tool_call")({ toolName: "edit", input: { path: "app.txt" } }, h.ctx)).block, true);
  await h.commands.get("waicc-decisions").handler("", h.ctx);
  assert.equal(h.shown.at(-1).openGates, 1); assert.equal(h.prompts.length, 0);
  await h.commands.get("waicc-develop").handler("--main", h.ctx);
  assert.equal(h.prompts.length, 1); assert.equal(loadSession(root, s.id).rounds.length, 1);
  assert.equal(await h.hooks.get("tool_call")({ toolName: "edit", input: { path: "app.txt" } }, h.ctx), undefined);
  await h.commands.get("waicc-decide").handler("D1 Keep policy", h.ctx);
  s = loadSession(root, s.id); assert.equal(s.status, "READY_TO_IMPLEMENT");
  await h.commands.get("waicc-limit").handler("code_review 5", h.ctx);
  assert.equal(loadSession(root, s.id).roundLimits!.code_review, 5);
  assert.equal(h.tools.has("waicc_develop"), false); assert.equal(h.tools.has("waicc_decide"), false);
  await h.commands.get("waicc-help-develop").handler("Whole-plan coding", h.ctx);
  s = loadSession(root, s.id);
  assert.equal(s.rounds.at(-1)!.mode, "implementation");
  assert.equal(s.rounds.at(-1)!.wholeWork, true);
  assert.equal((await h.hooks.get("tool_call")({ toolName: "edit", input: { path: "app.txt" } }, h.ctx)).block, true);
  await h.commands.get("waicc-receive").handler(`${s.id} --implement`, h.ctx);
  for (const [command, args] of [["waicc-develop", ""], ["waicc-help-develop", ""], ["waicc-implement", ""], ["waicc-decide", "D1 Keep policy"]]) {
    await h.commands.get(command).handler(args, h.ctx);
    assert.ok(h.notices.at(-1)!.includes("handoff recipient"));
  }
});

test("CLI supports same-session development, consolidated decisions, inline answers and phase limits", (t) => {
  const { root, s: initial } = fixture(t, true, true), cli = resolve("src/cli.ts");
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [cli, "--root", root, ...args], { encoding: "utf8", windowsHide: true }));
  const s = accept(root, answer(root, initial));
  assert.equal(run("decisions", s.id).openGates, 1);
  assert.equal(run("develop", s.id).status, "IMPLEMENTATION_GATED");
  assert.equal(run("decide", s.id, "D1", "Keep policy").status, "READY_TO_IMPLEMENT");
  assert.equal(run("limit", s.id, "code_review", "6").roundLimits.code_review, 6);
  const view = run("status", s.id);
  assert.equal(view.implementationAuthorized, true); assert.equal(view.rounds, 1);
  assert.equal(view.progress.reportedCompleteTasks, null);
});

test("new planning ready stays planning-only, continue cannot self-authorize, and specification-only closure remains explicit", async (t) => {
  const { root, s: initial } = fixture(t), h = harness(root);
  const s = accept(root, answer(root, initial, { outcome: "ready" }), "ready");
  assert.equal(s.status, "PLAN_READY"); assert.equal(s.rounds.length, 1);
  assert.equal(s.implementationAuthorization, undefined);
  await h.commands.get("waicc-use").handler(s.id, h.ctx);
  await h.commands.get("waicc-continue").handler("", h.ctx);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.shown.at(-1).implementationAuthorized, false);
  assert.ok(h.shown.at(-1).nextAction.includes("/waicc-develop"));
  const other = fixture(t, true);
  const spec = accept(other.root, answer(other.root, other.s));
  assert.equal(spec.status, "SPEC_APPROVED");
  assert.equal(closeSession(other.root, spec.id, "Planning-only objective accepted").status, "CLOSED");
  assert.throws(() => beginDevelopment(other.root, spec.id), /closed/);
});

test("an outstanding failed specification review blocks a fresh grant and a pending review never displays historical PASS", (t) => {
  const { root, s: initial } = fixture(t);
  let s = accept(root, answer(root, initial), "planned");
  s = issue(root, s.id, "review", "Review full specification", undefined, undefined, { kind: "contract" });
  s = accept(root, answer(root, s));
  assert.equal((status(root, s.id) as any).specificationReview.status, "PASS");
  s = issue(root, s.id, "review", "Recheck material concern", undefined, undefined, { kind: "contract" });
  assert.equal((status(root, s.id) as any).specificationReview.status, "PENDING");
  s = accept(root, answer(root, s, { outcome: "needs_changes", findings: [{ id: "F1", severity: "high", description: "Isolation plan incomplete", evidence: "ACB lacks a negative case" }] }), "needs_changes");
  assert.throws(() => beginDevelopment(root, s.id), /still requires changes/);
  assert.throws(() => delegateWork(root, s.id, "implementation", "Ignore failed specification"), /still requires changes/);
  assert.equal((status(root, s.id) as any).implementationAuthorized, false);
});

test("legacy accepted planning without planApproval retains exact assessment provenance when resolving a gate", (t) => {
  const { root, s: initial } = fixture(t, false, true, false);
  let s = accept(root, answer(root, initial), "planned");
  const acceptedRequest = s.rounds.at(-1)!.id;
  delete s.planApproval;
  journalCommit(root, s, "legacy.fixture-without-plan-approval");
  s = resolveDecision(root, s.id, "D1", "Keep policy");
  assert.equal(s.planApproval!.requestId, acceptedRequest);
  assert.equal(s.planApproval!.contractVersion, 2);
  assert.equal((status(root, s.id) as any).implementationAuthorized, false);
  s = beginDevelopment(root, s.id);
  assert.equal(s.planApproval!.requestId, acceptedRequest);
  assert.equal((status(root, s.id) as any).implementationAuthorized, true);
});

test("human decision answer bounds do not produce an invalid or truncated canonical contract", (t) => {
  const { root, s: initial } = fixture(t, true, true);
  const s = accept(root, answer(root, initial));
  const fullAnswer = "x".repeat(32_000);
  const decided = resolveDecision(root, s.id, "D1", fullAnswer);
  const c = readContract(root, s.id).contract;
  assert.equal(c.decisions![0].answer, fullAnswer);
  assert.deepEqual(validateContract(c, "Add account search"), c);
  assert.ok(c.decisions![0].evidence.at(-1)!.length < 300);
  assert.equal(decided.deliveryVerified, false);
});

test("/waicc-decide forgives a missing or mistyped ID, and alone lets the human pick and type the answer", async (t) => {
  // IDs match regardless of case; an unknown one lists the open decisions and the exact command.
  const lower = fixture(t, true, true);
  const sl = accept(lower.root, answer(lower.root, lower.s));
  resolveDecision(lower.root, sl.id, "d1", "Keep policy");
  assert.equal(readContract(lower.root, sl.id).contract.decisions![0].answer, "Keep policy");
  const unknown = fixture(t, true, true);
  const su = accept(unknown.root, answer(unknown.root, unknown.s));
  assert.throws(() => resolveDecision(unknown.root, su.id, "Reachability", "confirmed"),
    /Unknown decision ID "Reachability"\. Open decisions: D1 \(external\): Which backend policy\?\. Use \/waicc-decide <ID> <answer>, \/waicc-decide <ID> recommended, or \/waicc-decide alone to pick one\./);

  // Without a dialog: say what is wrong and what to type, recording nothing.
  const h = harness(unknown.root);
  await h.commands.get("waicc-use").handler(su.id, h.ctx);
  await h.commands.get("waicc-decide").handler("Reachability confirmed with controls", h.ctx);
  assert.match(h.notices.at(-1)!, /"Reachability" is not an open decision ID\. Open decisions: D1 \(external\)/);
  await h.commands.get("waicc-decide").handler("", h.ctx);
  assert.match(h.notices.at(-1)!, /^Usage: \/waicc-decide <decision-id> <answer>, or <decision-id> recommended\. Open decisions: D1/);
  await h.commands.get("waicc-decide").handler("D1", h.ctx);
  assert.match(h.notices.at(-1)!, /Add your answer: \/waicc-decide D1 <answer>, or \/waicc-decide D1 recommended/);
  assert.equal(readContract(unknown.root, su.id).contract.decisions![0].status, "open");

  // With a dialog: an answer typed without its ID is confirmed for the only open decision.
  const asked: string[] = [];
  const ui = (choice: { confirm: boolean; typed?: string }) => ({ ...h.ctx, hasUI: true, ui: {
    notify: (m: string) => h.notices.push(m),
    confirm: async (title: string, message: string) => (asked.push(`${title} ${message}`), choice.confirm),
    select: async (title: string, options: string[]) => (asked.push(`${title} ${options.join("|")}`), options[0]),
    input: async (title: string, placeholder: string) => (asked.push(`${title} ${placeholder}`), choice.typed),
  } }) as unknown as ExtensionCommandContext;
  await h.commands.get("waicc-decide").handler("Keep the current policy", ui({ confirm: false }));
  assert.match(asked.at(-1)!, /^Record this as the answer to D1\? Which backend policy\?/);
  assert.equal(readContract(unknown.root, su.id).contract.decisions![0].status, "open", "declined: nothing recorded");

  // Alone: pick the decision, then accept the recommendation or type your own.
  const typed = ui({ confirm: true, typed: "Keep the current policy" }) as any;
  typed.ui.select = async (title: string, options: string[]) => (asked.push(`${title} ${options.join(" | ")}`), title.startsWith("Which") ? options[0] : options.at(-1));
  await h.commands.get("waicc-decide").handler("", typed);
  assert.match(asked.at(-3)!, /^Which decision are you answering\? D1 \(external\): Which backend policy\?/);
  assert.match(asked.at(-2)!, /^D1: Which backend policy\? Accept the recommendation: Retain existing account-isolation policy \| Type my own answer$/);
  assert.match(asked.at(-1)!, /^D1: Which backend policy\? Recommended: Retain existing account-isolation policy/);
  const d1 = readContract(unknown.root, su.id).contract.decisions![0];
  assert.deepEqual([d1.status, d1.answer], ["resolved", "Keep the current policy"]);
});

test("/waicc-decide <ID> recommended and all recommended accept the agent's recommendation as your answer", async (t) => {
  const recommendation = "Retain existing account-isolation policy";
  // Typed with its ID, without a dialog: the recommendation is recorded as the answer.
  const one = fixture(t, true, true);
  const s1 = accept(one.root, answer(one.root, one.s));
  const h = harness(one.root);
  await h.commands.get("waicc-use").handler(s1.id, h.ctx);
  await h.commands.get("waicc-decide").handler("d1 recommended", h.ctx);
  assert.deepEqual(readContract(one.root, s1.id).contract.decisions!.map((d) => [d.id, d.status, d.answer]), [["D1", "resolved", recommendation]]);
  // all recommended: one dialog listing each question and recommendation; declining records nothing.
  const all = fixture(t, true, true);
  const s2 = accept(all.root, answer(all.root, all.s));
  const g = harness(all.root);
  await g.commands.get("waicc-use").handler(s2.id, g.ctx);
  const asked: string[] = [];
  const dialog = (agree: boolean) => ({ ...g.ctx, hasUI: true, ui: { notify: (m: string) => g.notices.push(m),
    confirm: async (title: string, message: string) => (asked.push(`${title}\n${message}`), agree) } }) as unknown as ExtensionCommandContext;
  await g.commands.get("waicc-decide").handler("all recommended", dialog(false));
  assert.match(asked.at(-1)!, /^Accept the recommendation for all 1 open decision\?\nD1: Which backend policy\?\n  → Retain existing/);
  assert.equal(readContract(all.root, s2.id).contract.decisions![0].status, "open");
  await g.commands.get("waicc-decide").handler("all recommended", dialog(true));
  assert.equal(readContract(all.root, s2.id).contract.decisions![0].answer, recommendation);
  await g.commands.get("waicc-decide").handler("all recommended", g.ctx);
  assert.match(g.notices.at(-1)!, /no open decisions/);
});

test("cancel, limit and force-close show the status view, never the session file with every source path", async (t) => {
  const { root, s } = fixture(t), h = harness(root);
  await h.commands.get("waicc-use").handler(s.id, h.ctx);
  for (const [command, args] of [["waicc-limit", "6"], ["waicc-cancel", s.id], ["waicc-force-close", `${s.id} stop`]]) {
    await h.commands.get(command).handler(args, h.ctx);
    const shown = h.shown.at(-1);
    assert.equal(shown.sessionId, s.id, command);
    assert.equal(typeof shown.rounds, "number", `${command} shows a round count, not the rounds with their source snapshots`);
  }
  assert.equal(h.shown.at(-1).status, "CLOSED");
  // Anything else that reaches the chat lists a snapshot's paths as a count; other `files` fields stay.
  const text = chatJson({ source: { fingerprint: "f", files: { "a.txt": "h1", "b.txt": "h2" } }, files: { user: "u.json", found: [] } });
  assert.deepEqual(JSON.parse(text), { source: { fingerprint: "f", files: "2 files (fingerprinted in the session file)" }, files: { user: "u.json", found: [] } });
});

test("plan errors name the tasks and requirements to fix, and text limits say the actual length", () => {
  const plan = structuredClone(contract);
  plan.requirements.push({ id: "R2", text: "Export", sourceQuote: "Add account search" });
  plan.tasks[1].allowedPaths = [];
  assert.throws(() => readyPlan(plan), /^Error: Every implementation task needs explicit allowed paths: B$/);
  plan.tasks[1].allowedPaths = ["other.txt"];
  assert.throws(() => readyPlan(plan), /Some requirements have no acceptance criteria: R2 \(reference each/);
  plan.tasks[0].acceptance = [];
  assert.throws(() => readyPlan(plan), /needs acceptance criteria: A$/);
  assert.throws(() => text("x".repeat(812), "Lesson", 600), /^Error: Lesson must be nonempty text \(maximum 600 characters\); it has 812$/);
  assert.throws(() => text("", "Lesson", 600), /^Error: Lesson must be nonempty text \(maximum 600 characters\)$/);
  assert.throws(() => relativePath(".git/config"), /Reserved path: \.git\/config \(\.git, \.svn and \.pi\/pi-waicc are never task paths/);
});

test("/waicc-reopen <id> reopens a session from a chat that has none selected, and selects it there", async (t) => {
  const { root, s } = fixture(t), closer = harness(root);
  await closer.commands.get("waicc-force-close").handler(s.id, closer.ctx);
  const h = harness(root);
  await h.commands.get("waicc-reopen").handler("Needed after all", h.ctx);
  assert.match(h.notices.at(-1)!, /^No WAICC session selected/);
  await h.commands.get("waicc-reopen").handler(`${s.id} Needed after all`, h.ctx);
  assert.notEqual(loadSession(root, s.id).status, "CLOSED");
  await h.commands.get("waicc-status").handler("", h.ctx);
  assert.equal(h.shown.at(-1).sessionId, s.id, "reopened here, so selected here");
});

test("long WAICC output reaches the model as a summary; the chat keeps all of it", async (t) => {
  const { root, s } = fixture(t), h = harness(root);
  const long = chatJson({ sessionId: s.id, status: "WAITING_FOR_REPLY", nextAction: "Dispatch the review", contract: { tasks: "x".repeat(20_000) } });
  const short = chatJson({ sessionId: s.id, status: "DRAFT" });
  const brief = JSON.parse(modelView(long));
  assert.deepEqual([brief.sessionId, brief.status, brief.nextAction], [s.id, "WAITING_FOR_REPLY", "Dispatch the review"], "the facts that steer the next step stay");
  assert.match(brief.contract, /^\(20,\d{3} characters shown to the human; waicc_status has them\)$/);
  assert.ok(modelView(long).length <= modelLimit);
  assert.equal(modelView(short), short);
  assert.match(modelView("y".repeat(9_000)), /^y{6000}\n… \(3,000 characters shown to the human/);
  const shown = { role: "custom", customType: "waicc", content: long, display: true, timestamp: 1 };
  const other = { role: "custom", customType: "waicc-context", content: long, display: false, timestamp: 2 };
  const result = await h.hooks.get("context")({ type: "context", messages: [shown, other] }, h.ctx);
  assert.equal(result.messages[0].content, modelView(long));
  assert.equal(result.messages[1].content, long, "only command output shown in the chat is summarized");
  assert.equal(shown.content, long, "the transcript itself is unchanged");
  assert.equal(await h.hooks.get("context")({ type: "context", messages: [{ ...shown, content: short }] }, h.ctx), undefined);
});
