import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { selfTest, selfTestText } from "../src/selftest.ts";
import type { AgentRunner } from "../src/dispatch.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR!;

/** A project, settings naming a pi profile per role, and a stand-in pi on PATH. */
function fixture(t: import("node:test").TestContext, roles: Record<string, string>) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-selftest-")));
  mkdirSync(join(root, ".git"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const program = join(bin, process.platform === "win32" ? "pi.cmd" : "pi");
  writeFileSync(program, process.platform === "win32" ? "@echo OK\r\n" : "#!/bin/sh\necho OK\n");
  chmodSync(program, 0o755);
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ profiles: { fast: { via: "pi", model: "m1" }, slow: { via: "pi", model: "m2" } }, roles }));
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(join(agentDir, "waicc-agents.json"), { force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("selftest passes every link and asks each role's model once, with its model", async (t) => {
  const root = fixture(t, { planning: "fast", review: "slow", advisor: "fast" });
  const asked: string[][] = [];
  const runner: AgentRunner = async (program, args) => {
    asked.push([program, ...args]);
    return { stdout: "OK\n", stderr: "", code: 0, killed: false };
  };
  const report = await selfTest(root, { runner });
  assert.equal(report.ok, true, selfTestText(report));
  const names = report.checks.map((c) => c.check);
  for (const name of ["Node.js", "Project folder", "Agent settings", "Role planning", "Role review", "Program pi", "Tool server", "Planning and review", "Model fast", "Model slow"])
    assert.ok(names.includes(name), name);
  // Optional roles left out warn without failing; each profile is asked once.
  assert.equal(report.checks.find((c) => c.check === "Role testing")!.result, "warn");
  assert.equal(asked.length, 2);
  assert.ok(asked.some((a) => a.includes("m1")) && asked.some((a) => a.includes("m2")));
  assert.match(selfTestText(report), /Everything WAICC needs works\.$/);
});

test("selftest fails on a missing needed role and on a model that does not answer, saying why", async (t) => {
  const root = fixture(t, { planning: "fast" });
  const runner: AgentRunner = async () => ({ stdout: "", stderr: "Not logged in", code: 1, killed: false });
  const report = await selfTest(root, { runner });
  assert.equal(report.ok, false);
  const line = (check: string) => report.checks.find((c) => c.check === check)!;
  assert.equal(line("Role review").result, "fail");
  assert.equal(line("Model fast").result, "fail");
  assert.match(line("Model fast").detail, /exited with 1: Not logged in/);
  assert.match(selfTestText(report), /✗ Model fast: .*\n.*2 checks failed\.$/s);
});

test("selftest --no-model asks no model", async (t) => {
  const root = fixture(t, { planning: "fast", review: "slow" });
  const report = await selfTest(root, { models: false, runner: async () => assert.fail("a model was asked") });
  assert.equal(report.ok, true, selfTestText(report));
  assert.ok(!report.checks.some((c) => c.check.startsWith("Model ")));
});
