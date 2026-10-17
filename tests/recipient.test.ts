import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { loadSession } from "../src/files.ts";
import { curate, propose } from "../src/memory.ts";
import {
  assertRecipientCurrent,
  assertRecipientEdit,
  receiveHandoff,
  recipientAssignment,
  submitRecipientReply,
} from "../src/recipient.ts";
import {
  amend,
  assess,
  cancel,
  closeSession,
  createSession,
  ingest,
  issue,
  prepare,
  status,
} from "../src/workflow.ts";
import type { Contract, Reply } from "../src/types.ts";

function contract(): Contract {
  return {
    title: "Search",
    requirements: [
      { id: "REQ-001", text: "Add search", sourceQuote: "Add search" },
    ],
    exclusions: [],
    assumptions: [],
    questions: [],
    risks: [],
    skills: ["wai-node"],
    tasks: [
      {
        id: "SEARCH",
        title: "Add search",
        requirementIds: ["REQ-001"],
        dependsOn: [],
        allowedPaths: ["source.txt", "src"],
        acceptance: [
          {
            id: "AC-001",
            text: "Return expected results",
            requirementIds: ["REQ-001"],
            verification: "Exercise search cases",
          },
        ],
      },
    ],
  };
}
function fixture(t: TestContext, mode: "planning" | "review" = "planning") {
  const root = mkdtempSync(join(tmpdir(), "waicc-recipient-"));
  t.after(() => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("waicc-recipient-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "source");
  const s = createSession(root, "Add search");
  prepare(root, s.id, contract(), mode, "Inspect search", 0);
  return { root, id: s.id };
}
function body(): Omit<
  Reply,
  | "schemaVersion"
  | "sessionId"
  | "requestId"
  | "contractVersion"
  | "requirementsDigest"
  | "sourceFingerprint"
  | "mode"
> {
  return {
    outcome: "ready",
    summary: "Inspected search scope; delivery unverified.",
    coverage: [
      {
        requirementId: "REQ-001",
        status: "addressed",
        evidence: "REQ-001 and AC-001 examined against source.txt",
      },
    ],
    findings: [],
    questions: [],
    checks: [
      {
        description: "Run search tests",
        outcome: "not_run",
        evidence: "No execution tools in this recipient profile",
      },
    ],
  };
}

test("receiving loads exact contract, history, skills and confirmed memory without advancing WAICC", (t) => {
  const { root, id } = fixture(t);
  curate(
    root,
    propose(root, "Search must remain account-scoped", "source.txt", "fact").id,
    "confirm",
  );
  propose(root, "Search candidate must not be recalled", "source.txt");
  const before = loadSession(root, id);
  const assignment = receiveHandoff(root, id);
  assert.equal(assignment.role, "recipient");
  assert.equal(assignment.pin.requestId, before.rounds[0].id);
  assert.equal(assignment.pin.contractVersion, 1);
  assert.equal(assignment.contract.version, 1);
  assert.equal(assignment.requirements, "Add search");
  assert.match(assignment.handoff, /Do not implement/);
  assert.ok(assignment.conversation);
  assert.ok(
    assignment.skills.some(
      (path) => path.endsWith(join("wai-node", "SKILL.md")) && existsSync(path),
    ),
  );
  assert.deepEqual(
    assignment.memory.map((m) => m.text),
    ["Search must remain account-scoped"],
  );
  assert.equal(assignment.replyExists, false);
  assert.deepEqual(loadSession(root, id), before);
});

test("internal reply uses shared validation, cannot overwrite, and needs coordinator intake and assessment", (t) => {
  const { root, id } = fixture(t);
  const assignment = receiveHandoff(root, id),
    before = loadSession(root, id);
  const invalid = [
    { ...body(), requestId: "another" },
    { ...body(), sessionId: "another" },
    { ...body(), contractVersion: 2 },
    { ...body(), schemaVersion: 2 },
    { ...body(), sourceFingerprint: "another" },
    { ...body(), requirementsDigest: "another" },
    { ...body(), mode: "review" },
    { ...body(), coverage: [] },
    { ...body(), coverage: [body().coverage[0], body().coverage[0]] },
    { ...body(), arbitrary: "field" },
    { ...body(), proposedContract: { ...contract(), requirements: [] } },
  ];
  for (const reply of invalid)
    assert.throws(() => submitRecipientReply(root, assignment.pin, reply));
  assert.equal(existsSync(assignment.replyPath), false);
  const submitted = submitRecipientReply(root, assignment.pin, body());
  assert.equal(submitted.submitted, true);
  const stored = JSON.parse(readFileSync(assignment.replyPath, "utf8"));
  assert.equal(stored.schemaVersion, 1);
  for (const [key, value] of Object.entries(assignment.pin))
    assert.equal(stored[key], value);
  assert.deepEqual(loadSession(root, id), before);
  assert.throws(
    () => submitRecipientReply(root, assignment.pin, body()),
    /reply already exists/,
  );
  assert.throws(() => receiveHandoff(root, id), /reply already exists/);
  assert.throws(
    () => assertRecipientCurrent(root, assignment.pin),
    /reply already exists/,
  );
  const received = ingest(root, id);
  assert.equal(received.status, "AWAITING_ASSESSMENT");
  assert.equal(received.rounds[0].status, "RECEIVED");
  assert.throws(
    () => submitRecipientReply(root, assignment.pin, body()),
    /no longer waiting/,
  );
  assess(root, id, {
    requestId: assignment.pin.requestId,
    decision: "ready",
    rationale: "Scope inspected; delivery unverified",
    dispositions: [],
  });
  assert.equal(loadSession(root, id).status, "READY_FOR_HANDOFF");
});

test("an existing external reply also prevents recipient overwrite", (t) => {
  const { root, id } = fixture(t);
  const a = receiveHandoff(root, id);
  const external = JSON.stringify(a.replyTemplate);
  writeFileSync(a.replyPath, external);
  assert.throws(
    () => submitRecipientReply(root, a.pin, body()),
    /reply already exists/,
  );
  assert.equal(readFileSync(a.replyPath, "utf8"), external);
});

test("Pi recipient accepts flexible findings without losing submitted annotations or self-assessing", (t) => {
  const { root, id } = fixture(t);
  const a = receiveHandoff(root, id);
  const input = {
    ...body(),
    findings: [
      {
        severity: "Medium",
        title: "Contract concern",
        evidence: ["REQ-001", "AC-001"],
        suggestion: "Clarify expected behavior",
      },
    ],
  };
  const result = submitRecipientReply(root, a.pin, input);
  assert.ok(result.normalization.length > 0);
  assert.deepEqual(
    JSON.parse(readFileSync(a.replyPath, "utf8")).findings,
    input.findings,
  );
  assert.equal(loadSession(root, id).status, "WAITING_FOR_REPLY");
  const received = ingest(root, id);
  assert.deepEqual(received.rounds[0].reply!.findings, [
    {
      id: "F-001",
      severity: "medium",
      description: "Contract concern",
      evidence: "REQ-001\nAC-001",
      extensions: { suggestion: "Clarify expected behavior" },
    },
  ]);
  assert.deepEqual(received.rounds[0].replyNormalization, result.normalization);
  assert.equal(received.status, "AWAITING_ASSESSMENT");
});

test("cancelled, amended, replaced and changed-source assignments never retarget the old recipient", (t) => {
  const { root, id } = fixture(t);
  const first = receiveHandoff(root, id);
  cancel(root, id, "Ask a new question");
  issue(root, id, "planning", "Investigate a different question");
  const next = receiveHandoff(root, id);
  assert.notEqual(first.pin.requestId, next.pin.requestId);
  assert.equal(first.pin.contractVersion, next.pin.contractVersion);
  assert.throws(
    () => recipientAssignment(root, first.pin),
    /no longer waiting/,
  );
  assert.throws(
    () => submitRecipientReply(root, first.pin, body()),
    /no longer waiting/,
  );
  amend(root, id, "Preserve pagination");
  assert.throws(
    () => assertRecipientCurrent(root, next.pin),
    /no longer waiting|changed/,
  );

  const other = fixture(t);
  const a = receiveHandoff(other.root, other.id);
  writeFileSync(join(other.root, "source.txt"), "changed source");
  assert.throws(() => receiveHandoff(other.root, other.id), /Source changed/);
  assert.throws(
    () => submitRecipientReply(other.root, a.pin, body()),
    /Source changed/,
  );
  assert.equal(existsSync(a.replyPath), false);
});

test("drafts, answered requests and closed contracts cannot be received", (t) => {
  const { root, id } = fixture(t, "review");
  const draft = createSession(root, "Add search");
  assert.throws(() => receiveHandoff(root, draft.id), /exactly one waiting/);
  const a = receiveHandoff(root, id);
  submitRecipientReply(root, a.pin, body());
  ingest(root, id);
  assert.throws(() => receiveHandoff(root, id), /exactly one waiting/);
  assess(root, id, {
    requestId: a.pin.requestId,
    decision: "ready",
    rationale: "Full contract checked",
    dispositions: [],
  });
  closeSession(root, id, "Contract discussion completed");
  assert.throws(() => receiveHandoff(root, id), /closed/);
  assert.throws(() => recipientAssignment(root, a.pin), /closed/);
});

test("advisor receiver preserves exact question and selected coverage without adopting suggestions", (t) => {
  const { root, id } = fixture(t);
  cancel(root, id, "Need decision advice");
  issue(root, id, "advisor", "Which search index?", undefined, ["REQ-001"]);
  const a = receiveHandoff(root, id);
  const reply = {
    ...body(),
    outcome: "needs_clarification" as const,
    questions: ["Expected search scale?"],
    findings: [
      {
        severity: "low",
        title: "Scale is unspecified",
        evidence:
          "The advisor question does not include expected search volume",
      },
    ],
    advice: {
      question: "Which search index?",
      options: [],
      recommendation: null,
      assumptions: [],
      proposedAmendments: [],
    },
  };
  assert.throws(
    () =>
      submitRecipientReply(root, a.pin, {
        ...reply,
        advice: { ...reply.advice, question: "Different question?" },
      }),
    /question does not match/,
  );
  assert.throws(
    () => submitRecipientReply(root, a.pin, { ...reply, coverage: [] }),
    /every requirement/,
  );
  assert.throws(() =>
    submitRecipientReply(root, a.pin, {
      ...reply,
      proposedContract: contract(),
    }),
  );
  submitRecipientReply(root, a.pin, reply);
  const received = ingest(root, id);
  assert.equal(received.contractVersion, 1);
  assert.equal(
    received.rounds.at(-1)!.reply!.findings[0].description,
    "Scale is unspecified",
  );
  assert.ok(received.rounds.at(-1)!.replyNormalization!.length > 0);
});

test("implementation needs explicit opt-in, restricts edits, and accepts assigned source changes at submission", (t) => {
  const { root, id } = fixture(t);
  const planning = receiveHandoff(root, id);
  assert.throws(
    () => assertRecipientEdit(root, planning.pin, "source.txt"),
    /cannot edit/,
  );
  submitRecipientReply(root, planning.pin, body());
  ingest(root, id);
  assess(root, id, {
    requestId: planning.pin.requestId,
    decision: "ready",
    rationale: "Plan inspected",
    dispositions: [],
  });
  assert.throws(() => receiveHandoff(root, id), /--implement/);
  const a = receiveHandoff(root, id, true);
  assert.equal(a.pin.mode, "implementation");
  assert.doesNotThrow(() => assertRecipientEdit(root, a.pin, "source.txt"));
  assert.doesNotThrow(() =>
    assertRecipientEdit(root, a.pin, join(root, "src", "new.ts")),
  );
  for (const path of [
    "outside.txt",
    "src-elsewhere/file.ts",
    "../escape",
    ".git/config",
    ".svn/entries",
    ".pi/pi-waicc/memory/entries.json",
    root,
  ])
    assert.throws(() => assertRecipientEdit(root, a.pin, path));
  mkdirSync(join(root, "target"));
  mkdirSync(join(root, "src"));
  symlinkSync(
    join(root, "target"),
    join(root, "src", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => assertRecipientEdit(root, a.pin, "src/linked/file.ts"),
    /Symlink\/junction/,
  );
  rmSync(join(root, "src", "linked"), { recursive: true, force: true });
  writeFileSync(join(root, "source.txt"), "implemented search");
  submitRecipientReply(root, a.pin, body());
  assert.equal(ingest(root, id).status, "AWAITING_ASSESSMENT");
});

// No inference/network: exercise actual registered callbacks with two independent Pi chat identities.
function harness(root: string, clipboardFailure = false) {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  const tools = new Map<string, any>();
  const hooks = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const prompts: string[] = [],
    shown: string[] = [],
    notices: string[] = [];
  const entries: { type: "custom"; customType: string; data: any }[] = [];
  const clipboard: string[] = [];
  const originalTools = [
    "read",
    "grep",
    "find",
    "ls",
    "edit",
    "write",
    "bash",
    "powershell",
    "mcp_server",
    "custom_exec",
    "waicc_status",
    "waicc_prepare",
    "waicc_assess",
    "waicc_request",
    "waicc_reply",
    "waicc_memory",
  ];
  let active = [...originalTools];
  const api = {
    registerCommand: (name: string, value: any) => commands.set(name, value),
    registerTool: (value: any) => tools.set(value.name, value),
    on: (name: string, handler: any) => hooks.set(name, handler),
    appendEntry: (customType: string, data: any) =>
      entries.push({ type: "custom", customType, data }),
    sendUserMessage: (content: string) => {
      prompts.push(content);
    },
    sendMessage: (message: { content: string }) => {
      shown.push(message.content);
    },
    getAllTools: () => originalTools.map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
    },
  };
  waicc(api as unknown as ExtensionAPI, {
    copyText: async (text) => {
      if (clipboardFailure) throw new Error("Display unavailable");
      clipboard.push(text);
    },
  });
  const ctx = (chat = "recipient", trusted = true, idle = true) =>
    ({
      cwd: root,
      mode: "json",
      isProjectTrusted: () => trusted,
      isIdle: () => idle,
      model: { provider: "anthropic", id: "test-claude" },
      sessionManager: { getSessionId: () => chat, getBranch: () => entries },
      ui: { notify: (message: string) => notices.push(message) },
    }) as unknown as ExtensionCommandContext;
  return {
    commands,
    tools,
    hooks,
    prompts,
    shown,
    notices,
    entries,
    clipboard,
    ctx,
    api,
    originalTools,
    active: () => active,
    call: (name: string, params: unknown, context = ctx()) =>
      tools
        .get(name)
        .execute("test-call", params, undefined, undefined, context),
    guard: (name: string, input: unknown = {}, context = ctx()) =>
      hooks.get("tool_call")!({ toolName: name, input }, context),
  };
}

test("new interactive handoffs auto-copy only the prompt; status does not overwrite and explicit copy can repeat", async (t) => {
  const { root, id } = fixture(t),
    h = harness(root);
  const ctx = { ...h.ctx(), mode: "tui" as const, hasUI: true };
  await h.commands.get("waicc-use")!.handler(id, ctx);
  await h.commands.get("waicc-limit")!.handler("12", ctx);
  await h.commands.get("waicc-continue")!.handler("", ctx);
  assert.equal(h.clipboard.length, 0);
  cancel(root, id, "Prepare another focused handoff");
  const prepared = await h.call(
    "waicc_prepare",
    {
      sessionId: id,
      contract: contract(),
      expectedVersion: 1,
      mode: "planning",
      focus: "Inspect source",
    },
    ctx,
  );
  assert.equal(prepared.details.clipboard.status, "copied");
  const view = status(root, id) as {
    manualHandoff: { copyPastePrompt: string };
  };
  assert.deepEqual(h.clipboard, [view.manualHandoff.copyPastePrompt]);
  assert.ok(!h.clipboard[0].includes("/waicc-continue"));
  await h.commands.get("waicc-status")!.handler("", ctx);
  await h.commands.get("waicc-continue")!.handler("", ctx);
  assert.equal(h.clipboard.length, 1);
  await h.commands.get("waicc-handoff")!.handler("", ctx);
  assert.equal(h.clipboard.length, 2);
  await h.commands.get("waicc-export")!.handler("", ctx);
  assert.equal(h.clipboard.length, 3);
  assert.ok(h.clipboard[2].includes("supplied export folder"));
  assert.ok(!h.clipboard[2].includes(root));
  await h.commands.get("waicc-receive")!.handler(id, ctx);
  await h.call("waicc_reply", { reply: body() }, ctx);
  assert.equal(h.clipboard.length, 3); // A recipient response is never a new manual handoff.
});

test("clipboard failure does not roll back a valid handoff and leaves a copyable fallback", async (t) => {
  const { root, id } = fixture(t),
    h = harness(root, true);
  const ctx = { ...h.ctx(), mode: "tui" as const, hasUI: true };
  await h.commands.get("waicc-use")!.handler(id, ctx);
  cancel(root, id, "Prepare fresh work");
  const result = await h.call(
    "waicc_prepare",
    {
      sessionId: id,
      contract: contract(),
      expectedVersion: 1,
      mode: "planning",
      focus: "Inspect",
    },
    ctx,
  );
  assert.equal(result.details.clipboard.status, "unavailable");
  assert.equal(loadSession(root, id).status, "WAITING_FOR_REPLY");
  assert.ok(h.shown.at(-1)!.includes("Copy ONLY the following block"));
  await h.commands.get("waicc-handoff")!.handler("", ctx);
  assert.ok(h.shown.at(-1)!.includes("Copy ONLY the following block"));
  assert.ok(h.shown.at(-1)!.includes("Clipboard unavailable"));
  assert.equal(h.clipboard.length, 0);
});

test("manual handoff command displays only the existing pinned assignment without inference or rebinding", async (t) => {
  const { root, id } = fixture(t),
    h = harness(root);
  const before = loadSession(root, id);
  const delivery = (
    status(root, id) as { manualHandoff: { copyPastePrompt: string } }
  ).manualHandoff;
  await h.commands.get("waicc-handoff")!.handler(id, h.ctx());
  const match = /^(`{3,})text\n([\s\S]*?)\n\1$/m.exec(h.shown.at(-1)!)!;
  assert.ok(match);
  assert.equal(match[2] + "\n", delivery.copyPastePrompt);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.entries.length, 0);
  assert.deepEqual(loadSession(root, id), before);
  await h.commands.get("waicc-handoff")!.handler("", h.ctx());
  assert.match(h.notices.at(-1)!, /No WAICC session selected/); // Explicit view did not bind.
  await h.commands.get("waicc-use")!.handler(id, h.ctx());
  await h.commands.get("waicc-handoff")!.handler("", h.ctx());
  assert.ok(h.shown.at(-1)!.includes(delivery.copyPastePrompt));
  const count = h.shown.length;
  await h.commands.get("waicc-handoff")!.handler(`${id} --other`, h.ctx());
  assert.match(h.notices.at(-1)!, /Usage/);
  assert.equal(h.shown.length, count);
  await h.commands.get("waicc-receive")!.handler(id, h.ctx());
  await h.commands.get("waicc-handoff")!.handler("", h.ctx());
  assert.match(h.notices.at(-1)!, /handoff recipient/);
  await h.call("waicc_reply", { reply: body() });
  const reader = harness(root);
  await reader.commands.get("waicc-handoff")!.handler(id, reader.ctx());
  assert.match(reader.notices.at(-1)!, /No unanswered waiting handoff/);
  assert.equal(reader.shown.length, 0);
  assert.equal(reader.prompts.length, 0);
});

test("copy-ready handoff survives a bounded tool preview for a large contract", async (t) => {
  const { root, id } = fixture(t),
    h = harness(root);
  cancel(root, id, "Expand the contract context");
  const large = contract();
  large.exclusions = ["x".repeat(32_000), "y".repeat(32_000)];
  prepare(root, id, large, "planning", "Inspect search", 1);
  const view = status(root, id) as {
    manualHandoff: { copyPastePrompt: string };
  };
  const text = (await h.call("waicc_status", { sessionId: id })).content[0]
    .text;
  assert.ok(text.includes("[Preview bounded;"));
  assert.ok(text.includes(JSON.stringify(view.manualHandoff.copyPastePrompt)));
});

test("Pi recipient is reply-only, denies coordinator/exec tools, and coordinator continues separately", async (t) => {
  const { root, id } = fixture(t),
    h = harness(root);
  await h.commands.get("waicc-use")!.handler(id, h.ctx("coordinator"));
  await h.commands.get("waicc-receive")!.handler(id, h.ctx());
  const pin = h.entries.at(-1)!.data.pin;
  assert.match(h.prompts[0], /RECIPIENT, not its coordinator/);
  assert.ok(h.prompts[0].includes(pin.requestId));
  assert.deepEqual(h.active(), [
    "read",
    "grep",
    "find",
    "ls",
    "waicc_status",
    "waicc_memory",
    "waicc_reply",
  ]);
  assert.equal(await h.guard("read", { path: "source.txt" }), undefined);
  for (const name of [
    "edit",
    "write",
    "bash",
    "powershell",
    "mcp_server",
    "custom_exec",
    "waicc_prepare",
    "waicc_assess",
    "waicc_request",
  ])
    assert.equal((await h.guard(name, { path: "source.txt" })).block, true);
  for (const name of ["waicc_prepare", "waicc_assess", "waicc_request"])
    await assert.rejects(
      () => h.call(name, { sessionId: id }),
      /handoff recipient/,
    );
  await assert.rejects(
    () =>
      h.call("waicc_memory", {
        action: "propose",
        claim: "Search fact",
        source: "source.txt",
      }),
    /handoff recipient/,
  );
  for (const [name, args] of [
    ["waicc-continue", ""],
    ["waicc-close", "done"],
    ["waicc-cancel", "stop"],
    ["waicc-amend", "More scope"],
    ["waicc-memory", "confirm fake"],
  ]) {
    await h.commands.get(name)!.handler(args, h.ctx());
    assert.match(h.notices.at(-1)!, /handoff recipient/);
  }
  assert.equal(h.prompts.length, 1);
  const reply = JSON.parse(
    (await h.call("waicc_reply", { reply: body() })).content[0].text,
  );
  assert.equal(reply.requestId, pin.requestId);
  assert.equal(loadSession(root, id).status, "WAITING_FOR_REPLY");
  assert.equal(h.entries.at(-1)!.customType, "waicc-recipient-submitted");
  assert.equal(h.entries.at(-1)!.data.model, "test-claude");
  assert.equal((await h.guard("read")).block, true);
  assert.equal(await h.guard("waicc_status"), undefined);
  const turn = await h.hooks.get("before_agent_start")!({}, h.ctx());
  assert.match(turn.message.content, /STOP: A reply already exists/);
  await assert.rejects(
    () => h.call("waicc_reply", { reply: body() }),
    /reply already exists/,
  );
  await h.commands.get("waicc-continue")!.handler("", h.ctx("coordinator"));
  assert.equal(loadSession(root, id).status, "AWAITING_ASSESSMENT");
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1], /Assess the received reply/);
});

test("Pi resumes its original pin, reports invalidation, and requires explicit role change for new work", async (t) => {
  const { root, id } = fixture(t),
    h = harness(root);
  await h.commands.get("waicc-receive")!.handler(id, h.ctx());
  const saved = structuredClone(h.entries[0]);
  const resumed = harness(root);
  resumed.entries.push(saved);
  await resumed.hooks.get("session_start")!({}, resumed.ctx());
  assert.deepEqual(resumed.active(), h.active());
  assert.equal(resumed.prompts.length, 0);
  assert.equal(
    JSON.parse((await resumed.call("waicc_status", {})).content[0].text).pin
      .requestId,
    saved.data.pin.requestId,
  );
  cancel(root, id, "Replace request");
  issue(root, id, "review", "Review independently");
  const current = loadSession(root, id).rounds.at(-1)!;
  const status = JSON.parse(
    (await resumed.call("waicc_status", {})).content[0].text,
  );
  assert.equal(status.stopped, true);
  assert.equal(status.pin.requestId, saved.data.pin.requestId);
  assert.notEqual(status.pin.requestId, current.id);
  assert.equal((await resumed.guard("read")).block, true);
  await resumed.commands.get("waicc-receive")!.handler(id, resumed.ctx());
  assert.match(resumed.notices.at(-1)!, /pinned to another request/);
  assert.equal(resumed.prompts.length, 0);
  await resumed.commands.get("waicc-use")!.handler(id, resumed.ctx());
  assert.deepEqual(resumed.active(), resumed.originalTools);
  assert.equal(await resumed.guard("bash"), undefined);
  await resumed.commands.get("waicc-receive")!.handler(id, resumed.ctx());
  assert.equal(resumed.entries.at(-1)!.data.pin.requestId, current.id);
  assert.equal(resumed.prompts.length, 1);
});

test("Pi receive rejects unsafe entry conditions before binding and preserves legacy coordinator resume", async (t) => {
  const { root, id } = fixture(t),
    h = harness(root);
  for (const [args, context, expected] of [
    [id, h.ctx("recipient", false), /Trust the project/],
    [id, h.ctx("recipient", true, false), /Wait for the current Pi run/],
    [`${id} --unknown`, h.ctx(), /Usage/],
    ["", h.ctx(), /Usage/],
  ] as const) {
    await h.commands.get("waicc-receive")!.handler(args, context);
    assert.match(h.notices.at(-1)!, expected);
  }
  assert.equal(h.entries.length, 0);
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.active(), h.originalTools);
  await assert.rejects(
    () => h.call("waicc_reply", { reply: body() }),
    /Use \/waicc-receive/,
  );
  h.entries.push({
    type: "custom",
    customType: "waicc-session",
    data: { projectRoot: root, sessionId: id },
  });
  await h.hooks.get("session_start")!({}, h.ctx());
  assert.equal(
    JSON.parse((await h.call("waicc_status", {})).content[0].text).sessionId,
    id,
  );
  assert.equal(await h.guard("bash"), undefined);
});

test("Pi implementation receiver exposes scoped edits only after human opt-in; shell remains blocked", async (t) => {
  const { root, id } = fixture(t),
    h = harness(root);
  const a = receiveHandoff(root, id);
  submitRecipientReply(root, a.pin, body());
  ingest(root, id);
  assess(root, id, {
    requestId: a.pin.requestId,
    decision: "ready",
    rationale: "Plan checked",
    dispositions: [],
  });
  await h.commands.get("waicc-receive")!.handler(id, h.ctx());
  assert.match(h.notices.at(-1)!, /--implement/);
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.active(), h.originalTools);
  await h.commands.get("waicc-receive")!.handler(`${id} --implement`, h.ctx());
  assert.ok(h.active().includes("edit"));
  assert.ok(h.active().includes("write"));
  assert.equal(await h.guard("edit", { path: "source.txt" }), undefined);
  assert.equal(await h.guard("write", { path: "src/new.ts" }), undefined);
  assert.equal((await h.guard("edit", { path: "other.txt" })).block, true);
  assert.equal(
    (await h.guard("write", { path: ".pi/pi-waicc/state.json" })).block,
    true,
  );
  assert.equal((await h.guard("bash", { command: "npm test" })).block, true);
});
