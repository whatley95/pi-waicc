import { test } from "node:test";
import assert from "node:assert/strict";
import { copyHandoffPrompt } from "../src/clipboard.ts";

test("clipboard delegates exact Unicode prompt text to the host writer without shell interpolation", async () => {
  const prompt =
    "Read C:\\项目\\HANDOFF.md\nDo not execute $(anything) or `commands`.\n";
  const writes: string[] = [];
  const result = await copyHandoffPrompt(prompt, "tui", async (text) => {
    writes.push(text);
  });
  assert.equal(result.status, "copied");
  assert.deepEqual(writes, [prompt]);
});

test("clipboard failures keep a manual fallback and do not fail the handoff", async () => {
  const result = await copyHandoffPrompt("prompt", "tui", async () => {
    throw new Error("Display permission denied");
  });
  assert.equal(result.status, "unavailable");
  assert.match(result.message, /permission denied.*manually/);
});

test("RPC, JSON and print modes never call a clipboard writer or emit terminal control sequences", async () => {
  let writes = 0;
  for (const mode of ["rpc", "json", "print", "unknown"]) {
    const result = await copyHandoffPrompt("prompt", mode, async () => {
      writes++;
    });
    assert.equal(result.status, "not_attempted");
  }
  assert.equal(writes, 0);
});
