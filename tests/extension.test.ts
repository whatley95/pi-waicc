import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { listSessions } from "../src/files.ts";
import {
  assess,
  cancel,
  createSession,
  ingest,
  prepare,
} from "../src/workflow.ts";
import { curate, propose } from "../src/memory.ts";

test("Pi 1.4.0's actual extension loader accepts commands and can execute handoff preparation", async (t) => {
  const { loadExtensions } =
    await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const result = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  for (const name of [
    "waicc-planning",
    "waicc-auto-planning",
    "waicc-develop",
    "waicc-decisions",
    "waicc-decide",
    "waicc-compact",
    "waicc-help-develop",
    "waicc-implement",
    "waicc-test",
    "waicc-review",
    "waicc-advisor",
    "waicc-continue",
    "waicc-receive",
    "waicc-handoff",
    "waicc-status",
    "waicc-list",
    "waicc-delete",
    "waicc-restore",
    "waicc-close",
    "waicc-force-close",
    "waicc-reopen",
  ])
    assert.ok(result.extensions[0].commands.has(name));
  for (const name of [
    "waicc_prepare",
    "waicc_start_planning",
    "waicc_assess",
    "waicc_memory",
    "waicc_reply",
    "waicc_context",
    "waicc_checkpoint",
    "waicc_check",
  ])
    assert.ok(result.extensions[0].tools.has(name));
  assert.ok(!result.extensions[0].tools.has("waicc_close"));
  assert.ok(!result.extensions[0].tools.has("waicc_reopen"));
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-loader-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-loader-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "source");
  const session = createSession(root, "Add search");
  const prepared = await result.extensions[0].tools
    .get("waicc_prepare")!
    .definition.execute(
      "loader-test",
      {
        sessionId: session.id,
        expectedVersion: 0,
        mode: "planning",
        focus: "Inspect source and plan search",
        contract: {
          title: "Search",
          requirements: [
            { id: "REQ-001", text: "Add search", sourceQuote: "Add search" },
          ],
          exclusions: [],
          assumptions: [],
          questions: [],
          risks: [],
          tasks: [
            {
              id: "SEARCH",
              title: "Add search",
              requirementIds: ["REQ-001"],
              dependsOn: [],
              allowedPaths: ["source.txt"],
              acceptance: [
                {
                  id: "AC-001",
                  text: "Search returns expected results",
                  requirementIds: ["REQ-001"],
                  verification: "Exercise known search cases",
                },
              ],
            },
          ],
          skills: ["wai-node"],
        },
      },
      undefined,
      undefined,
      {
        cwd: root,
        isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "loader-chat" },
      } as unknown as ExtensionToolContext,
    );
  const content = prepared.content[0];
  assert.equal(content.type, "text");
  if (content.type === "text")
    assert.equal(JSON.parse(content.text).status, "WAITING_FOR_REPLY");
  cancel(root, session.id, "Ask for focused advice");
  const advised = await result.extensions[0].tools
    .get("waicc_request")!
    .definition.execute(
      "advisor-loader-test",
      {
        sessionId: session.id,
        mode: "advisor",
        focus: "Which search strategy?",
        requirementIds: ["REQ-001"],
      },
      undefined,
      undefined,
      {
        cwd: root,
        isProjectTrusted: () => true,
        sessionManager: { getSessionId: () => "loader-chat" },
      } as unknown as ExtensionToolContext,
    );
  assert.equal(advised.content[0].type, "text");
  if (advised.content[0].type === "text") {
    const view = JSON.parse(advised.content[0].text);
    assert.equal(view.contractVersion, 1);
    assert.equal(view.pending.mode, "advisor");
    assert.deepEqual(view.pending.advisor.requirementIds, ["REQ-001"]);
  }
});

test("advisor slash command issues a handoff without model inference and continue assesses it as advice", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-advisor-command-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-advisor-command-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "source");
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  const shown: string[] = [],
    prompts: string[] = [],
    notices: string[] = [];
  waicc({
    registerCommand: (
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => commands.set(name, command),
    registerTool() {},
    on() {},
    appendEntry() {},
    sendMessage(message: { content: string }) {
      shown.push(message.content);
    },
    sendUserMessage(content: string) {
      prompts.push(content);
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "advisor-chat" },
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;
  const s = createSession(root, "Add search");
  await commands.get("waicc-use")!.handler(s.id, ctx);
  await commands.get("waicc-advisor")!.handler("Which approach?", ctx);
  assert.match(notices.at(-1)!, /Prepare a contract/);
  prepare(
    root,
    s.id,
    {
      title: "Search",
      requirements: [
        { id: "REQ-001", text: "Add search", sourceQuote: "Add search" },
      ],
      exclusions: [],
      assumptions: [],
      questions: [],
      risks: [],
      tasks: [
        {
          id: "SEARCH",
          title: "Add search",
          requirementIds: ["REQ-001"],
          dependsOn: [],
          allowedPaths: ["source.txt"],
          acceptance: [
            {
              id: "AC-001",
              text: "Return expected search results",
              requirementIds: ["REQ-001"],
              verification: "Exercise search cases",
            },
          ],
        },
      ],
      skills: [],
    },
    "planning",
    "Investigate",
    0,
  );
  cancel(root, s.id, "Pause for advice");
  await commands
    .get("waicc-advisor")!
    .handler("--requirements REQ-001 Which approach?", ctx);
  assert.equal(prompts.length, 0);
  const view = JSON.parse(shown.at(-1)!);
  assert.equal(view.pending.mode, "advisor");
  assert.deepEqual(view.pending.advisor, {
    question: "Which approach?",
    requirementIds: ["REQ-001"],
  });
  await commands.get("waicc-continue")!.handler("", ctx);
  assert.equal(prompts.length, 0); // No reply: do not start an assessment turn.
  const reply = JSON.parse(
    readFileSync(
      view.pending.replyPath.replace("reply.json", "reply.example.json"),
      "utf8",
    ),
  );
  reply.summary = "Need scale information before recommending an approach.";
  writeFileSync(view.pending.replyPath, JSON.stringify(reply));
  await commands.get("waicc-continue")!.handler("", ctx);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /never ready or contract/);
  assert.match(prompts[0], /Which approach/);
  assess(root, s.id, {
    requestId: view.pending.requestId,
    decision: "needs_changes",
    rationale: "Clarify the scale before advice can be completed.",
    dispositions: [],
  });
  await commands.get("waicc-continue")!.handler("", ctx);
  assert.equal(prompts.length, 1); // Do not turn incomplete advice into an automatic contract revision.
  assert.equal(JSON.parse(shown.at(-1)!).status, "NEEDS_CHANGES");
  // Existing-contract review is pinned to v1 without inference or a silent revision.
  await commands
    .get("waicc-review")!
    .handler("--contract Check full-contract readiness", ctx);
  assert.equal(prompts.length, 1);
  const review = JSON.parse(shown.at(-1)!);
  assert.equal(review.contractVersion, 1);
  assert.equal(review.pending.mode, "review");
  const reviewReply = JSON.parse(
    readFileSync(
      review.pending.replyPath.replace("reply.json", "reply.example.json"),
      "utf8",
    ),
  );
  reviewReply.outcome = "ready";
  reviewReply.summary =
    "Reviewed the contract against source and requirements; delivery unverified.";
  reviewReply.questions = [];
  reviewReply.coverage.forEach((row: { status: string; evidence: string }) => {
    row.status = "addressed";
    row.evidence = "REQ-001 and AC-001 examined against source.txt.";
  });
  writeFileSync(review.pending.replyPath, JSON.stringify(reviewReply));
  ingest(root, s.id);
  assess(root, s.id, {
    requestId: review.pending.requestId,
    decision: "ready",
    rationale: "Contract coverage checked; no implementation claimed.",
    dispositions: [],
  });
  await commands.get("waicc-status")!.handler("", ctx);
  assert.equal(JSON.parse(shown.at(-1)!).status, "READY_TO_CLOSE");
  await commands.get("waicc-close")!.handler("Contract accepted", ctx);
  const closed = JSON.parse(shown.at(-1)!);
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.contractReview, "PASS");
  assert.equal(closed.deliveryVerified, false);
  await commands.get("waicc-continue")!.handler("", ctx);
  assert.equal(prompts.length, 1);
  await commands.get("waicc-review")!.handler("Not before reopening", ctx);
  assert.match(notices.at(-1)!, /Contract is closed/);
  await commands.get("waicc-reopen")!.handler("Reconsider the contract", ctx);
  assert.equal(JSON.parse(shown.at(-1)!).status, "NEEDS_REVIEW");
  assert.equal(JSON.parse(shown.at(-1)!).contractReview, "NOT_REVIEWED");
  assert.equal(prompts.length, 1);
});
test("planning saves the user's request before prompting; chats keep separate session bindings", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-extension-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-extension-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "source");
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  const sent: string[] = [];
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const notices: string[] = [];
  const api = {
    registerCommand: (
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => commands.set(name, command),
    registerTool() {},
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      hooks.set(event, handler);
    },
    appendEntry() {},
    sendUserMessage(content: string) {
      sent.push(content);
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  waicc(api);
  const context = (chat: string, trusted = true) =>
    ({
      cwd: root,
      isProjectTrusted: () => trusted,
      sessionManager: { getSessionId: () => chat },
      ui: { notify: (message: string) => notices.push(message) },
    }) as unknown as ExtensionCommandContext;
  await commands
    .get("waicc-planning")!
    .handler("Add search", context("chat-a"));
  await commands
    .get("waicc-planning")!
    .handler("Add pagination", context("chat-b"));
  assert.equal(listSessions(root).length, 2);
  assert.ok(sent[0].includes("Add search"));
  assert.ok(sent[1].includes("Add pagination"));
  await commands.get("waicc-continue")!.handler("", context("chat-a"));
  assert.ok(sent[2].includes("Add search"));
  assert.ok(!sent[2].includes("Add pagination"));
  await commands
    .get("waicc-planning")!
    .handler("Untrusted task", context("chat-c", false));
  assert.equal(listSessions(root).length, 2);
  assert.match(notices.at(-1)!, /Trust the project/);
  // Recall is driven by the user's request, not WAICC's fixed instruction wording.
  writeFileSync(join(root, "billing.txt"), "billing");
  for (const [claim, source] of [
    ["Customer search must stay account-scoped", "source.txt"],
    ["Billing invoices are generated nightly", "billing.txt"],
    ["Project requirements are inspected by planning agents", "billing.txt"],
  ])
    curate(root, propose(root, claim, source, "fact").id, "confirm");
  await commands
    .get("waicc-planning")!
    .handler("Add customer search", context("chat-d"));
  const planning = sent.at(-1)!.split("Relevant confirmed project memory:")[1];
  assert.ok(planning.includes("account-scoped"));
  assert.ok(!planning.includes("Billing"));
  assert.ok(!planning.includes("planning agents"));
  const turn = (await hooks.get("before_agent_start")!(
    {},
    context("chat-d"),
  )) as { message: { content: string } };
  assert.ok(turn.message.content.includes("account-scoped"));
  assert.ok(!turn.message.content.includes("Billing"));
});

test("tools accept nested arguments sent as JSON text, which some models do", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-extension-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.txt"), "source");
  const tools = new Map<string, any>(), commands = new Map<string, any>(), entries: any[] = [];
  waicc({
    registerCommand: (n: string, c: any) => commands.set(n, c), registerTool: (tool: any) => tools.set(tool.name, tool), on() {},
    appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "json-text-chat", getBranch: () => entries }, ui: { notify() {} },
  } as unknown as ExtensionToolContext;
  const session = createSession(root, "Add search");
  await commands.get("waicc-use").handler(session.id, ctx);
  const contract = {
    title: "Search", requirements: [{ id: "REQ-001", text: "Add search", sourceQuote: "Add search" }],
    exclusions: [], assumptions: [], questions: [], risks: [], skills: ["wai-node"],
    tasks: [{ id: "SEARCH", title: "Add search", requirementIds: ["REQ-001"], dependsOn: [], allowedPaths: ["source.txt"],
      acceptance: [{ id: "AC-001", text: "Search returns expected results", requirementIds: ["REQ-001"], verification: "Exercise known search cases" }] }],
  };
  // The contract arrives as JSON text, as in the reported "Contract must be an object" retry loop.
  const prepared = await tools.get("waicc_prepare").execute("x", {
    sessionId: session.id, expectedVersion: 0, mode: "planning", focus: "Plan search", contract: JSON.stringify(contract),
  }, undefined, undefined, ctx);
  assert.match(prepared.content[0].text, /WAITING_FOR_REPLY/);
  // Plain-text arguments stay text, even when they look like JSON.
  const { decodeJsonArguments } = await import("../src/validation.ts");
  assert.deepEqual(decodeJsonArguments({ focus: "{not decoded}", contract: "{\"a\":1}", note: "plain" },
    { properties: { focus: { type: "string" }, contract: {}, note: {} } }), { focus: "{not decoded}", contract: { a: 1 }, note: "plain" });
  assert.equal(decodeJsonArguments({ contract: "{broken" }, { properties: { contract: {} } }).contract, "{broken");
});
