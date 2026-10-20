import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildOnDisk, buildOutdated, loadedBuild } from "../src/build.ts";
import { projectStatus } from "../src/tracker.ts";

test("the build digest follows the code and templates on disk, and nothing else", (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  const src = join(base, "src"), templates = join(base, "templates");
  mkdirSync(join(src, "tools"), { recursive: true });
  mkdirSync(templates);
  writeFileSync(join(src, "index.ts"), "export default 1;");
  writeFileSync(join(src, "tools", "a.ts"), "export const a = 1;");
  writeFileSync(join(templates, "tracker.html"), "<p>page</p>");
  const first = buildOnDisk(src, templates);
  assert.match(first, /^[a-f0-9]{12}$/);
  writeFileSync(join(src, "notes.md"), "not code");
  assert.equal(buildOnDisk(src, templates), first, "files that are not code or templates are ignored");
  writeFileSync(join(src, "tools", "a.ts"), "export const a = 2;");
  const second = buildOnDisk(src, templates);
  assert.notEqual(second, first, "a change in a nested module is a new build");
  writeFileSync(join(templates, "tracker.html"), "<p>new page</p>");
  assert.notEqual(buildOnDisk(src, templates), second, "a new page is a new build");
});

test("a chat learns its loaded copy is outdated once the files on disk change, checked at most once a minute", () => {
  assert.match(loadedBuild.build, /^[a-f0-9]{12}$/);
  assert.equal(loadedBuild.build, buildOnDisk(), "the loaded copy is the one on disk");
  const start = Date.now() + 3_600_000;
  assert.equal(buildOutdated(start, () => loadedBuild.build), false);
  assert.equal(buildOutdated(start + 30_000, () => "changed00000"), false, "not checked again within a minute");
  assert.equal(buildOutdated(start + 61_000, () => "changed00000"), true);
  assert.equal(buildOutdated(start + 200_000, () => loadedBuild.build), true, "once outdated, it stays so until /reload loads the new copy");
});

test("an outdated chat asks the human to /reload on the tracker", (t) => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const status = projectStatus(base, [], [], null, null, { version: "0.1.0", build: "abc123abc123", outdated: true });
  assert.deepEqual(status.extension, { version: "0.1.0", build: "abc123abc123", outdated: true });
  assert.deepEqual(status.needsYou.map((n) => n.command), ["/reload"]);
  assert.deepEqual(projectStatus(base, [], [], null, null, { version: "0.1.0", build: "abc123abc123", outdated: false }).needsYou, []);
});
