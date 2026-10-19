import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// Node refuses to strip types under node_modules, so an installed bin must be compiled JavaScript.
test("installed CLI bin runs from node_modules as compiled JavaScript", (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(manifest.bin.waicc, /^\.\/dist\/.+\.js$/);
  assert.ok(manifest.files.includes("dist"));
  assert.ok(manifest.files.includes("templates"), "the default agent config ships with the package");
  const installed = join(base, "node_modules", "pi-waicc");
  execFileSync(
    process.execPath,
    [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", join(installed, "dist")],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  cpSync("skills", join(installed, "skills"), { recursive: true });
  cpSync("package.json", join(installed, "package.json"));
  const project = join(base, "project");
  mkdirSync(project);
  writeFileSync(join(project, "app.txt"), "original source\n");
  const invoke = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [join(installed, manifest.bin.waicc), "--root", project, ...args], {
        encoding: "utf8",
        windowsHide: true,
      }),
    );
  const session = invoke("start", "Add customer search.");
  assert.equal(session.status, "DRAFT");
  assert.equal(invoke("status", session.id).sessionId, session.id);
  // Dispatch starts this compiled MCP server for installed packages.
  const mcp = execFileSync(process.execPath, [join(installed, manifest.bin.waicc), "--root", project, "mcp"], {
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(JSON.parse(mcp).result.serverInfo.name, "waicc");
});
