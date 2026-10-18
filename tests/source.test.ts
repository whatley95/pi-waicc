import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { digest, loadSession } from "../src/files.ts";
import { normalizeSvnXml, projectRoot } from "../src/source.ts";
import { createSession } from "../src/workflow.ts";

test("SVN metadata normalizes attribute permutations and start-tag layout before hashing", () => {
  const variants = [
    '<entry path="app.txt"><wc-status props="none" item="normal" revision="1"><commit revision="1" /></wc-status></entry>',
    '<entry\n path="app.txt"><wc-status\n item="normal"\n revision="1"\n props="none"><commit\n revision="1"/></wc-status></entry>',
    '<entry path="app.txt"><wc-status revision="1" props="none" item="normal"><commit revision = "1" /></wc-status></entry>',
  ];
  const fingerprints = variants.map((xml) => digest(normalizeSvnXml(xml)));
  assert.equal(new Set(fingerprints).size, 1);
  assert.notEqual(digest(variants[0]), digest(variants[1]));
  assert.equal(
    normalizeSvnXml(normalizeSvnXml(variants[0])),
    normalizeSvnXml(variants[0]),
  );
});

test("SVN metadata normalization retains paths, revisions and working-copy status changes", () => {
  const xml =
    '<entry path="dir &amp; name/app.txt"><wc-status props="none" item="normal" revision="1"></wc-status></entry>';
  const fingerprint = digest(normalizeSvnXml(xml));
  for (const changed of [
    xml.replace('item="normal"', 'item="modified"'),
    xml.replace('props="none"', 'props="modified"'),
    xml.replace('revision="1"', 'revision="2"'),
    xml.replace("app.txt", "other.txt"),
  ])
    assert.notEqual(digest(normalizeSvnXml(changed)), fingerprint);
});

test("SVN property values, whitespace, encoding and escaped data remain significant", () => {
  const first =
    '<property name="custom:binary" encoding="base64">AAE=</property>';
  const reordered =
    '<property\n encoding="base64"\n name="custom:binary">AAE=</property>';
  assert.equal(normalizeSvnXml(first), normalizeSvnXml(reordered));
  assert.notEqual(
    normalizeSvnXml(first),
    normalizeSvnXml(first.replace("AAE=", "AAI=")),
  );
  assert.notEqual(
    normalizeSvnXml(first),
    normalizeSvnXml(first.replace('encoding="base64"', 'encoding="text"')),
  );
  const text =
    '<property name="custom:text">  &lt;tag item=&quot;x&quot;&gt;\nvalue\t &amp; more  </property>';
  assert.equal(normalizeSvnXml(text), text);
  assert.notEqual(
    normalizeSvnXml(text),
    normalizeSvnXml(text.replace("  </property>", " </property>")),
  );
});

test("a session loads through any spelling of its project directory", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  // Another spelling of the same directory, as an agent's working directory can be:
  // a link here; on Windows also a short 8.3 name or different letter case.
  const link = join(realpathSync.native(tmpdir()), `${basename(root)}-link`);
  symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
  t.after(() => {
    // Remove only the link itself; a recursive delete could follow it into the project.
    if (process.platform === "win32") rmdirSync(link);
    else unlinkSync(link);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "app.txt"), "source\n");
  const s = createSession(root, "Add search");
  assert.equal(projectRoot(link), root, "one canonical root");
  assert.equal(loadSession(link, s.id).id, s.id);
  if (process.platform === "win32") assert.equal(loadSession(root.toUpperCase(), s.id).id, s.id);
});
