import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { snapshot, sourceLimits } from "../src/source.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

/** A committed repository of six files that counts as large once the direct limit is lowered to 3. */
function largeRepo(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const limits = { ...sourceLimits };
  sourceLimits.direct = 3;
  t.after(() => {
    Object.assign(sourceLimits, limits);
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "services", "orders"), { recursive: true });
  for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "services/orders/app.js", "services/orders/README.md"])
    writeFileSync(join(root, name), `${name}\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Six files");
  return root;
}

test("a large Git project is fingerprinted with Git's own blob IDs, hashing only what changed", (t) => {
  const root = largeRepo(t);
  const clean = snapshot(root);
  assert.equal(Object.keys(clean.files).length, 6);
  for (const [path, value] of Object.entries(clean.files))
    assert.equal(value, `git:${git(root, "rev-parse", `HEAD:${path}`)}`, `${path} carries the committed blob ID`);
  assert.equal(snapshot(root).fingerprint, clean.fingerprint, "stable when nothing changes");

  // Edited, new and deleted files: each the ID git would give its current content.
  writeFileSync(join(root, "a.txt"), "edited\n");
  writeFileSync(join(root, "new.txt"), "new\n");
  unlinkSync(join(root, "b.txt"));
  const changed = snapshot(root);
  assert.equal(changed.files["a.txt"], `git:${git(root, "hash-object", "a.txt")}`);
  assert.equal(changed.files["new.txt"], `git:${git(root, "hash-object", "new.txt")}`);
  assert.equal(changed.files["b.txt"], "DELETED");
  assert.equal(changed.files["c.txt"], clean.files["c.txt"], "untouched files keep their ID");
  assert.notEqual(changed.fingerprint, clean.fingerprint);

  // Staging an edit keeps the file's value, since its content is the same.
  git(root, "add", "a.txt");
  assert.equal(snapshot(root).files["a.txt"], changed.files["a.txt"]);
});

test("a monorepo service fingerprints only its own files in that mode, and the Git limit still applies", (t) => {
  const root = largeRepo(t);
  sourceLimits.direct = 1;
  const service = snapshot(join(root, "services", "orders"));
  assert.deepEqual(Object.keys(service.files).sort(), ["README.md", "app.js"]);
  assert.equal(service.files["app.js"], `git:${git(root, "rev-parse", "HEAD:services/orders/app.js")}`);

  sourceLimits.git = 5;
  assert.throws(() => snapshot(root), /Source exceeds 5 files \(6\)\. In a monorepo, run \/waicc-init/);
});

test("projects within the direct limit are still read file by file, as before", (t) => {
  const root = largeRepo(t);
  sourceLimits.direct = 10_000;
  const s = snapshot(root);
  assert.ok(Object.values(s.files).every((value) => /^[a-f0-9]{64}$/.test(value)), "content digests, not Git IDs");
});

test("cached file digests keep fingerprints and miss no change, even one that keeps size and modified time", async (t) => {
  const root = largeRepo(t);
  sourceLimits.direct = 10_000;
  const file = join(root, "services", "orders", "app.js");
  const content = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  // Same values as reading every file: existing sessions keep their fingerprints.
  const first = snapshot(root);
  assert.equal(first.files["services/orders/app.js"], content(file));

  // Edited within the 2 s window: never trusted from a cache, however the times line up.
  const { mtime } = statSync(file);
  writeFileSync(file, "SERVICES/orders/app.js\n");
  utimesSync(file, mtime, mtime);
  assert.equal(snapshot(root).files["services/orders/app.js"], content(file));

  // Once files are old enough to be kept, a same-size edit that restores the modified time
  // still changes the file's change time, so it is read again.
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const kept = snapshot(root);
  assert.equal(kept.files["services/orders/app.js"], content(file));
  await new Promise((resolve) => setTimeout(resolve, 50));
  writeFileSync(file, "services/ORDERS/app.js\n");
  utimesSync(file, mtime, mtime);
  const after = snapshot(root);
  assert.equal(after.files["services/orders/app.js"], content(file));
  assert.notEqual(after.fingerprint, kept.fingerprint);
  // A deleted file and a link are still seen as such.
  unlinkSync(join(root, "a.txt"));
  assert.equal(snapshot(root).files["a.txt"], "DELETED");
  try {
    symlinkSync(join(root, "b.txt"), join(root, "link.txt"));
  } catch {
    return; // Windows without the right to make links.
  }
  assert.throws(() => snapshot(root), /Unsupported source entry: link\.txt|Source symlink/);
});

test("Git's index and files come from one call, fingerprinted exactly as `git ls-files --stage` prints them", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, ".gitignore"), "*.log\n");
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "sub", "b.txt"), "b\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Start");
  writeFileSync(join(root, "new.txt"), "untracked\n");
  writeFileSync(join(root, "skip.log"), "ignored\n");
  const s = snapshot(root);
  // Recorded handoffs keep this fingerprint, so it must not change with how Git is asked.
  assert.equal(s.vcsState, createHash("sha256").update(execFileSync("git", ["ls-files", "--stage", "-z"], { cwd: root })).digest("hex"));
  assert.deepEqual(Object.keys(s.files).sort(), [".gitignore", "a.txt", "new.txt", "sub/b.txt"]);
});
