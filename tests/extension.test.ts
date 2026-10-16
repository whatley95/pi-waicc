import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { listSessions } from "../src/files.ts";
import { createSession } from "../src/workflow.ts";

test("Pi 1.2.0's actual extension loader accepts commands and can execute handoff preparation", async (t) => {
  const { loadExtensions } =
    await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
  const result = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  for (const name of [
    "waicc-planning",
    "waicc-review",
    "waicc-continue",
    "waicc-status",
  ])
    assert.ok(result.extensions[0].commands.has(name));
  for (const name of ["waicc_prepare", "waicc_assess", "waicc_memory"])
    assert.ok(result.extensions[0].tools.has(name));
  const root = mkdtempSync(join(tmpdir(), "waicc-loader-"));
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
      } as unknown as ExtensionToolContext,
    );
  const content = prepared.content[0];
  assert.equal(content.type, "text");
  if (content.type === "text")
    assert.equal(JSON.parse(content.text).status, "WAITING_FOR_REPLY");
});
test("planning saves the user's request before prompting; chats keep separate session bindings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "waicc-extension-"));
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
  const notices: string[] = [];
  const api = {
    registerCommand: (
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => commands.set(name, command),
    registerTool() {},
    on() {},
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
});
