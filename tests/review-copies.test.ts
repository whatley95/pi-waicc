import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { changesSinceReview, reviewedCopies } from "../src/review-copies.ts";

function folder(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("a review keeps copies of its changed text files, not binaries or files outside the project", (t) => {
  const root = folder(t);
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  assert.deepEqual(reviewedCopies(root, ["a.ts", "logo.png", "gone.ts", "../outside.ts"]), { "a.ts": "export const a = 1;\n" });
});

test("changes since a review: edits, new and deleted files, and what the reviewer must read whole", (t) => {
  const root = folder(t);
  writeFileSync(join(root, "edited.ts"), "const x = 2;\n");
  writeFileSync(join(root, "added.ts"), "export const added = true;\n");
  writeFileSync(join(root, "uncopied.ts"), "now\n");
  const kept: Record<string, string> = { "edited.ts": "const x = 1;\n", "deleted.ts": "old\n" };
  const existed = new Set(["edited.ts", "deleted.ts", "uncopied.ts"]);
  const result = changesSinceReview(root, ["added.ts", "deleted.ts", "edited.ts", "uncopied.ts"], (path) => kept[path], (path) => existed.has(path));
  assert.equal(result.paths, 3);
  assert.deepEqual(result.unavailable, ["uncopied.ts"], "it existed, but the review kept no copy: read it whole");
  assert.equal(result.truncated, false);
  assert.match(result.patch, /--- \/dev\/null\n\+\+\+ b\/added\.ts\n@@ [^\n]+@@\n\+export const added = true;\n/);
  assert.match(result.patch, /--- a\/deleted\.ts\n\+\+\+ \/dev\/null\n@@ [^\n]+@@\n-old\n/);
  assert.match(result.patch, /--- a\/edited\.ts\n\+\+\+ b\/edited\.ts\n@@ [^\n]+@@\n-const x = 1;\n\+const x = 2;\n/);
});
