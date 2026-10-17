import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { checkpointData, checkpointView, frozenCheckpointView, refreshCheckpoint } from "../src/checkpoint.ts";
import { artifact, commit, digest, json, loadSession, sessionRelative } from "../src/files.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { snapshot } from "../src/source.ts";
import { amend, assess, cancel, createSession, exportHandoff, forceCloseSession, ingest, issue, prepare, saveContext } from "../src/workflow.ts";
import type { Contract, Session } from "../src/types.ts";

const contract: Contract = {
  title: "Account search", requirements: [{ id: "R1", text: "Account search", sourceQuote: "Add account search" }],
  exclusions: ["Production deployment"], assumptions: ["Keep the existing API shape"], risks: ["Cross-account access"], questions: [], skills: [],
  decisions: [{ id: "D1", question: "Keep API shape?", owner: "human", status: "resolved", affectedTaskIds: ["T1"],
    evidence: ["User decision: keep compatibility because old clients remain supported"], recommendation: "Preserve API shape", answer: "Yes, retain compatibility" }],
  tasks: [{ id: "T1", title: "Implement search", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["source.txt"],
    acceptance: [{ id: "AC1", text: "Search is account scoped", requirementIds: ["R1"], verification: "Run isolation checks" }] }],
};
function fixture(t: TestContext, prepared = true) {
  const root = mkdtempSync(join(tmpdir(), "waicc-checkpoint-"));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-checkpoint-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "original source");
  let s = createSession(root, "Add account search");
  s = saveContext(root, s.id, "Owner kept API compatibility because old clients remain supported. No deployment.");
  if (prepared) s = prepare(root, s.id, contract, "planning", "Inspect source and plan", 0);
  return { root, s: loadSession(root, s.id) };
}
function data(s: Session) { return JSON.parse(artifact(s.projectRoot, s, s.checkpoint!.jsonPath)) as ReturnType<typeof checkpointData>; }

test("automatic checkpoints preserve exact ID/path coverage and bounded briefs without copying the archive into the prompt", (t) => {
  const { root, s: initial } = fixture(t, false);
  const many: Contract = { ...contract, tasks: Array.from({ length: 90 }, (_, i) => ({ ...contract.tasks[0],
    id: `T${i + 1}`, acceptance: [{ ...contract.tasks[0].acceptance[0], id: `AC${i + 1}` }] })) };
  const s = prepare(root, initial.id, many, "planning", "Inspect all 90 tasks", 0), d = data(s);
  assert.equal(s.checkpoint!.sequence, s.sequence);
  assert.equal(d.tasks.length, 90);
  assert.deepEqual(d.requirementIds, ["R1"]);
  assert.deepEqual(d.tasks.at(-1)!.acceptanceIds, ["AC90"]);
  assert.deepEqual(d.tasks[0].allowedPaths, ["source.txt"]);
  assert.deepEqual(d.decisionIds[0], { id: "D1", status: "resolved", owner: "human", affectedTaskIds: ["T1"] });
  assert.equal(d.deliveryVerified, false);
  assert.equal(d.contract!.requirementsCurrent, true);
  assert.ok(d.artifacts.every((ref) => !ref.path.startsWith("checkpoints/") && !ref.path.includes("checkpoint.json")));
  const view = checkpointView(root, s);
  assert.ok(view.brief.length < 10_000);
  assert.ok(view.brief.includes("because old clients"));
  assert.ok(!view.brief.includes("\\n\\n"));
  assert.equal(view.sourceMatchesPendingRequest, true);
  for (const ref of d.artifacts) assert.equal(digest(artifact(root, s, ref.path)), ref.digest);
});

test("intake and assessment checkpoint all findings, failed/not-run claims and rationale without certifying completion", (t) => {
  const { root, s: original } = fixture(t), a = receiveHandoff(root, original.id);
  submitRecipientReply(root, a.pin, {
    outcome: "needs_changes", summary: "Account isolation is incomplete", coverage: [{ requirementId: "R1", status: "unverified", evidence: "source.txt needs investigation" }],
    findings: [{ id: "F1", severity: "high", description: "Cross-account access", evidence: "source.txt lacks an account guard", suggestedFix: "Add guard and isolation regression" }],
    questions: [], checks: [{ description: "Isolation check", outcome: "failed", evidence: "Fixture failure" },
      { description: "Build", outcome: "not_run", evidence: "No execution permission" }],
  });
  let s = ingest(root, original.id);
  assert.equal(data(s).pending!.status, "RECEIVED");
  s = assess(root, s.id, { requestId: a.pin.requestId, decision: "needs_changes", rationale: "Investigate all findings before a new plan", dispositions: [] });
  let d = data(s);
  assert.equal(d.status, "NEEDS_CHANGES");
  assert.equal(d.findings[0].recordedDisposition, null);
  assert.deepEqual(d.checkClaims.map((c) => c.outcome), ["failed", "not_run"]);
  assert.ok(checkpointView(root, s).brief.includes("Investigate all findings"));
  const before = s;
  writeFileSync(join(root, "source.txt"), "changed source");
  const view = checkpointView(root, s);
  assert.equal(view.sourceMatchesCheckpoint, false);
  assert.equal(view.reviewApprovalCurrent, false);
  assert.deepEqual(loadSession(root, s.id), before);
  s = amend(root, s.id, "Also document compatibility");
  d = data(s);
  assert.equal(d.contract!.requirementsCurrent, false);
  assert.equal(d.requirements.length, 2);
  assert.equal(d.findings.length, 1);
  assert.equal(s.planApproval, null);
});

test("plain checkpoint refresh is idempotent and cannot rewrite a pending handoff or elevate its state", (t) => {
  const { root, s } = fixture(t), r = s.rounds.at(-1)!;
  const originals = Object.keys(s.artifacts).map((path) => [path, artifact(root, s, path)]);
  refreshCheckpoint(root, s.id);
  assert.deepEqual(loadSession(root, s.id), s);
  assert.throws(() => saveContext(root, s.id, "New notes while waiting"), /pending handoff/);
  assert.equal(frozenCheckpointView(root, s, r.id).requestId, r.id);
  for (const [path, value] of originals) assert.equal(artifact(root, loadSession(root, s.id), path), value);
});

test("portable checkpoint references resolve to byte-identical original evidence under archive", (t) => {
  const { root, s } = fixture(t), r = s.rounds.at(-1)!;
  const output = exportHandoff(root, s.id);
  const d = JSON.parse(readFileSync(join(output, "checkpoint.json"), "utf8")) as ReturnType<typeof checkpointData>;
  assert.equal(readFileSync(join(output, "checkpoint.json"), "utf8"), artifact(root, s, `rounds/${r.id}/checkpoint.json`));
  for (const ref of d.artifacts) {
    const content = readFileSync(join(output, "archive", ref.path), "utf8");
    assert.equal(digest(content), ref.digest);
    assert.equal(content, artifact(root, s, ref.path));
  }
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.checkpointArtifactBase, "archive/");
  assert.equal(manifest.includesSourceCode, false);
  assert.equal(data(loadSession(root, s.id)).findings.length, 0);
});

test("tampered checkpoints or referenced evidence cannot be silently compacted into a replacement", (t) => {
  for (const target of ["brief", "index", "requirements"] as const) {
    const { root, s } = fixture(t);
    const path = target === "brief" ? s.checkpoint!.markdownPath : target === "index" ? s.checkpoint!.jsonPath : "requirements.md";
    writeFileSync(join(root, sessionRelative(s.id), path), "tampered");
    assert.throws(() => checkpointView(root, s), /modified|committed/);
    assert.throws(() => refreshCheckpoint(root, s.id), /modified|committed/);
    assert.deepEqual(loadSession(root, s.id), s);
  }
});

test("legacy recovery is read-only until explicit checkpointing and CLOSED recovery never writes or reopens", (t) => {
  const { root, s: initial } = fixture(t);
  const legacy = structuredClone(initial);
  delete legacy.checkpoint;
  commit(root, legacy, "legacy.fixture");
  const s = loadSession(root, legacy.id);
  assert.equal(checkpointView(root, s).saved, false);
  assert.deepEqual(loadSession(root, s.id), s);
  refreshCheckpoint(root, s.id);
  const saved = loadSession(root, s.id);
  assert.equal(saved.sequence, s.sequence + 1);
  assert.ok(saved.checkpoint);
  forceCloseSession(root, s.id);
  const closed = loadSession(root, s.id);
  assert.equal(refreshCheckpoint(root, s.id).saved, true);
  assert.deepEqual(loadSession(root, s.id), closed);
  assert.equal(closed.status, "CLOSED");
});

function harness(root: string) {
  const commands = new Map<string, any>(), tools = new Map<string, any>(), hooks = new Map<string, any>();
  const notices: string[] = [], shown: any[] = [], prompts: string[] = [], entries: any[] = [], compactions: any[] = [];
  let active = ["read", "edit", "write", "bash", "waicc_checkpoint", "waicc_status", "waicc_reply"];
  waicc({ registerCommand: (n: string, c: any) => commands.set(n, c), registerTool: (t: any) => tools.set(t.name, t),
    on: (n: string, h: any) => hooks.set(n, h), appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => active.map((name) => ({ name })), getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    sendMessage: (m: any) => shown.push(m), sendUserMessage: (m: string) => prompts.push(m),
  } as unknown as ExtensionAPI);
  const ctx = { cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "checkpoint-chat", getBranch: () => entries },
    ui: { notify: (m: string) => notices.push(m) }, compact: (options: unknown) => compactions.push(options),
  } as unknown as ExtensionCommandContext;
  return { commands, tools, hooks, notices, shown, prompts, entries, compactions, ctx, active: () => active,
    async tool(name: string, params = {}) { return tools.get(name).execute("fixture", params, undefined, undefined, ctx as unknown as ExtensionToolContext); } };
}

test("manual and automatic Pi compaction preserve ownership/evidence, report outcomes honestly and restore compact context", async (t) => {
  const { root, s } = fixture(t, false), h = harness(root);
  await h.commands.get("waicc-use").handler(s.id, h.ctx);
  await h.commands.get("waicc-compact").handler("Keep migration reversible because old clients remain", h.ctx);
  const saved = loadSession(root, s.id);
  assert.ok(saved.context!.summary.includes("Owner kept API"));
  assert.ok(saved.context!.summary.includes("Keep migration reversible"));
  assert.equal(saved.implementationOwner, s.implementationOwner);
  assert.equal(saved.status, "DRAFT");
  assert.equal(h.compactions.length, 1);
  assert.ok(h.compactions[0].customInstructions.includes("not_run"));
  assert.equal(h.prompts.length, 0);
  assert.ok(!h.notices.some((n) => n.includes("context compacted")));
  h.compactions[0].onError(new Error("fixture failure"));
  assert.ok(h.notices.at(-1)!.includes("compaction failed"));
  h.compactions[0].onComplete({});
  assert.ok(h.notices.at(-1)!.includes("context compacted"));
  assert.equal(await h.hooks.get("session_before_compact")({ reason: "threshold" }, h.ctx), undefined);
  assert.deepEqual(loadSession(root, s.id), saved);
  const rehydrated = await h.hooks.get("before_agent_start")({}, h.ctx);
  assert.ok(rehydrated.message.content.includes(saved.checkpoint!.markdownPath.split("/")[1]));
  assert.ok(rehydrated.message.content.includes("Keep migration reversible"));
  const resumed = harness(root);
  resumed.entries.push(...h.entries);
  await resumed.hooks.get("session_start")({}, resumed.ctx);
  const recovered = JSON.parse((await resumed.tool("waicc_checkpoint")).content[0].text);
  assert.equal(recovered.sessionId, s.id);
  assert.equal(recovered.sequence, saved.sequence);
  const untrusted = { ...h.ctx, isProjectTrusted: () => false };
  await h.commands.get("waicc-compact").handler("", untrusted);
  assert.ok(h.notices.at(-1)!.includes("Trust the project"));
  assert.equal(h.compactions.length, 1);
});

test("recipient compaction stays pinned and cannot save notes, restore tools or follow a replacement request", async (t) => {
  const { root, s } = fixture(t), h = harness(root);
  await h.commands.get("waicc-receive").handler(s.id, h.ctx);
  const tools = [...h.active()], before = loadSession(root, s.id);
  assert.ok(tools.includes("waicc_checkpoint"));
  assert.ok(!tools.includes("bash"));
  await h.commands.get("waicc-compact").handler("", h.ctx);
  assert.equal(h.compactions.length, 1);
  assert.deepEqual(loadSession(root, s.id), before);
  assert.deepEqual(h.active(), tools);
  await h.commands.get("waicc-compact").handler("pretend permission", h.ctx);
  assert.ok(h.notices.at(-1)!.includes("handoff recipient"));
  assert.equal(h.compactions.length, 1);
  const recovered = JSON.parse((await h.tool("waicc_checkpoint")).content[0].text);
  assert.equal(recovered.requestId, before.rounds.at(-1)!.id);
  cancel(root, s.id);
  issue(root, s.id, "planning", "New request, not for the old recipient");
  assert.equal((await h.hooks.get("session_before_compact")({}, h.ctx)).cancel, true);
  assert.ok((await h.hooks.get("before_agent_start")({}, h.ctx)).message.content.includes("STOP"));
  await assert.rejects(() => h.tool("waicc_checkpoint"), /no longer waiting/);
  assert.deepEqual(h.active(), tools);
});

test("compaction hooks cancel on corruption without changing state; CLI checkpointing does not claim to compact chat", async (t) => {
  const { root, s } = fixture(t), h = harness(root);
  const cli = resolve("src/cli.ts");
  const invoke = (command: string) => JSON.parse(execFileSync(process.execPath, [cli, "--root", root, command, s.id], { encoding: "utf8" }));
  assert.equal(invoke("checkpoint").sessionId, s.id);
  assert.equal(invoke("compact").sequence, s.sequence);
  assert.deepEqual(loadSession(root, s.id), s);
  await h.commands.get("waicc-use").handler(s.id, h.ctx);
  writeFileSync(join(root, sessionRelative(s.id), "requirements.md"), "tampered original");
  assert.equal((await h.hooks.get("session_before_compact")({}, h.ctx)).cancel, true);
  await h.commands.get("waicc-compact").handler("", h.ctx);
  await h.commands.get("waicc-compact").handler("Must not hide damaged evidence", h.ctx);
  assert.equal(h.compactions.length, 0);
  assert.deepEqual(loadSession(root, s.id), s);
  assert.equal(snapshot(root).fingerprint, s.rounds.at(-1)!.source.fingerprint);
});

test("human cancellation and force-close are not blocked by damaged evidence needed only for a checkpoint", (t) => {
  for (const stop of [cancel, forceCloseSession]) {
    const { root, s } = fixture(t);
    writeFileSync(join(root, sessionRelative(s.id), "contracts/v001/contract.json"), "damaged contract artifact");
    const stopped = stop(root, s.id);
    assert.equal(stopped.status, stop === cancel ? "NEEDS_CHANGES" : "CLOSED");
    assert.equal(stopped.rounds.at(-1)!.status, "CANCELLED");
    assert.equal(stopped.contractReview, "NOT_REVIEWED");
    assert.equal(stopped.deliveryVerified, false);
    assert.throws(() => refreshCheckpoint(root, s.id), /modified|committed/);
  }
});

test("mid-run threshold/overflow compaction recovers on the very next model request without another agent start", async (t) => {
  for (const recipient of [false, true]) {
    const { root, s } = fixture(t), h = harness(root);
    await h.commands.get(recipient ? "waicc-receive" : "waicc-use").handler(s.id, h.ctx);
    const before = loadSession(root, s.id), tools = [...h.active()], prompts = h.prompts.length;
    assert.equal(await h.hooks.get("context")({ messages: [] }, h.ctx), undefined);
    await h.hooks.get("session_compact")({ reason: "overflow", willRetry: true }, h.ctx);
    const first = await h.hooks.get("context")({ messages: [] }, h.ctx);
    assert.equal(first.messages.length, 1);
    assert.equal(first.messages[0].role, "custom");
    assert.ok(first.messages[0].content.includes(s.id));
    if (recipient) assert.ok(first.messages[0].content.includes(before.rounds.at(-1)!.id));
    const next = await h.hooks.get("context")({ messages: first.messages }, h.ctx);
    assert.equal(next.messages.length, 1); // Replace only our own request-local recovery.
    assert.equal(h.prompts.length, prompts);
    assert.deepEqual(h.active(), tools);
    assert.deepEqual(loadSession(root, s.id), before);
    if (recipient) {
      cancel(root, s.id);
      issue(root, s.id, "planning", "Replacement must not be followed");
      const stopped = await h.hooks.get("context")({ messages: [] }, h.ctx);
      assert.ok(stopped.messages[0].content.startsWith("STOP"));
    }
    await h.hooks.get("before_agent_start")({}, h.ctx);
    assert.equal(await h.hooks.get("context")({ messages: [] }, h.ctx), undefined);
  }
});
