import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadSession, runtimePath } from "../src/files.ts";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { snapshot } from "../src/source.ts";
import { assess, beginDevelopment, cancel, createSession, ingest, issue, prepare } from "../src/workflow.ts";
import type { Contract, WorkCompletion } from "../src/types.ts";

const scope: Contract = {
  title: "Search", requirements: [{ id: "R1", text: "Search with account isolation", sourceQuote: "Add search with account isolation" }],
  exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
  tasks: [{ id: "API", title: "API", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["API.txt"],
    acceptance: [{ id: "AC0", text: "Search respects account isolation", requirementIds: ["R1"], verification: "Run search regression checks" }] }],
};
const report = (): WorkCompletion => ({
  summary: "All work complete", tasks: [{ taskId: "API", evidence: "API.txt implements AC0" }],
  checks: [{ description: "Search regression checks", outcome: "passed", evidence: "Fixture evidence" }], findings: [],
});

test("each source snapshot is stored once beside the journal, so entries stay small as rounds add up", (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  // A project large enough that one snapshot outweighs the rest of the session.
  mkdirSync(join(root, "src"));
  for (let i = 0; i < 1500; i++) writeFileSync(join(root, "src", `module-${i}.ts`), `export const value${i} = ${i};\n`);
  writeFileSync(join(root, "API.txt"), "original API");

  const s = createSession(root, "Add search with account isolation", undefined, "planning");
  prepare(root, s.id, scope, "planning", "Plan", 0);
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "planned", summary: "Planned", coverage: [{ requirementId: "R1", status: "addressed", evidence: "API.txt" }],
    findings: [], questions: [], checks: [{ description: "Read API", outcome: "passed", evidence: "Source inspected" }],
  });
  assess(root, s.id, { requestId: ingest(root, s.id).rounds.at(-1)!.id, decision: "planned", rationale: "Checked", dispositions: [] });
  beginDevelopment(root, s.id, "main");
  // Three code reviews of three versions of the change: each keeps its own source and base.
  for (const version of [1, 2, 3]) {
    writeFileSync(join(root, "API.txt"), `implemented API v${version}`);
    if (loadSession(root, s.id).rounds.some((r) => r.status === "WAITING")) cancel(root, s.id, "Next version");
    issue(root, s.id, "review", `Review version ${version}`, undefined, undefined, { kind: "code", completion: report() });
  }

  const folder = join(root, runtimePath, "sessions", s.id);
  const stored = readdirSync(join(folder, "snapshots"));
  const snapshotBytes = statSync(join(folder, "snapshots", stored[0])).size;
  assert.ok(snapshotBytes > 100_000, `one snapshot is large (${snapshotBytes} bytes)`);
  const entries = readdirSync(join(folder, "journal")).sort();
  const latest = readFileSync(join(folder, "journal", entries.at(-1)!), "utf8");
  assert.ok(latest.length < snapshotBytes / 2, `the latest entry (${latest.length} bytes) holds references, not copies`);
  assert.doesNotMatch(latest, /module-17\.ts/);
  // The same project state is stored once, however many rounds point at it.
  const loaded = loadSession(root, s.id);
  const fingerprints = new Set(loaded.rounds.flatMap((r) => [r.source.fingerprint, ...(r.review?.kind === "code" ? [r.review.base.fingerprint] : [])]));
  assert.equal(stored.length, fingerprints.size);

  // Loaded sessions have every file map back, exactly as captured.
  const current = snapshot(root);
  assert.deepEqual({ ...loaded.rounds.at(-1)!.source.files }, { ...current.files });
  assert.equal(loaded.rounds.at(-1)!.source.fingerprint, current.fingerprint);
  assert.ok(loaded.rounds.every((r) => Object.keys(r.source.files).length > 1500 && !("filesRef" in r.source)));

  // An entry written before this, with every snapshot inline, still loads.
  const inline = JSON.parse(latest);
  inline.session = structuredClone(loaded);
  inline.session.updatedAt = inline.at;
  writeFileSync(join(folder, "journal", entries.at(-1)!), JSON.stringify(inline));
  assert.deepEqual({ ...loadSession(root, s.id).rounds.at(-1)!.source.files }, { ...current.files });
  // The next commit stores it with references again.
  cancel(root, s.id, "Once more");
  issue(root, s.id, "review", "Review once more", undefined, undefined, { kind: "code", completion: report() });
  const next = readdirSync(join(folder, "journal")).sort().at(-1)!;
  assert.ok(readFileSync(join(folder, "journal", next), "utf8").length < snapshotBytes / 2);
});

test("a changed snapshot file is refused, never silently used", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "API.txt"), `unique ${root}`);
  const s = createSession(root, "Add search with account isolation", undefined, "planning");
  prepare(root, s.id, scope, "planning", "Plan", 0);
  const folder = join(root, runtimePath, "sessions", s.id, "snapshots");
  for (const name of readdirSync(folder)) writeFileSync(join(folder, name), JSON.stringify({ "API.txt": "0".repeat(64) }));
  // Earlier loads in this process keep the verified copy; a new process reads the file again.
  const fresh = await import(`../src/files.ts?fresh=${Date.now()}`);
  assert.throws(() => fresh.loadSession(root, s.id), /Source snapshot [a-f0-9]{64} was modified/);
});
