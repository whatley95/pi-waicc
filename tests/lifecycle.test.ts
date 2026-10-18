import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  deletedSessionRelative,
  listDeletedSessions,
  listSessions,
  loadDeletedSession,
  loadSession,
  sessionRelative,
  withLock,
} from "../src/files.ts";
import { deleteSession, restoreSession } from "../src/lifecycle.ts";
import { propose } from "../src/memory.ts";
import {
  createSession,
  exportHandoff,
  forceCloseSession,
  prepare,
  reopenSession,
  status,
} from "../src/workflow.ts";
import { snapshot } from "../src/source.ts";

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-lifecycle-")));
  t.after(() => {
    assert.equal(dirname(root), realpathSync.native(tmpdir()));
    assert.ok(basename(root).startsWith("waicc-lifecycle-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "source.txt"), "original source");
  const s = createSession(root, "Add search");
  prepare(root, s.id, {
    title: "Search brief",
    requirements: [{ id: "REQ-001", text: "Add search", sourceQuote: "Add search" }],
    exclusions: [], assumptions: [], questions: [], risks: [], tasks: [], skills: [],
  }, "planning", "Inspect source and plan", 0);
  return { root, id: s.id };
}
function tree(path: string): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(directory: string, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(directory, entry.name), `${name}/`);
      else files[name] = readFileSync(join(directory, entry.name)).toString("base64");
    }
  }
  visit(path);
  return files;
}
function listed(root: string, filter?: "open" | "all" | "closed" | "deleted") {
  return (status(root, undefined, filter) as {
    filter: string; sessions: { id: string; status: string }[];
  });
}

test("default session lists omit CLOSED; all/closed are explicit read-only views", (t) => {
  const { root, id } = fixture(t);
  const closed = forceCloseSession(root, id);
  const open = createSession(root, "Another objective");
  assert.deepEqual(listed(root).sessions.map((s) => s.id), [open.id]);
  assert.deepEqual(listed(root, "closed").sessions.map((s) => s.id), [id]);
  assert.equal(listed(root, "all").sessions.length, 2);
  assert.deepEqual(listed(root, "deleted").sessions, []);
  assert.equal((status(root, id) as { status: string }).status, "CLOSED");
  assert.deepEqual(loadSession(root, id), closed);
  assert.deepEqual(loadSession(root, open.id), open);
});

test("deleting one closed session moves its entire byte-identical history and restoration keeps it CLOSED", (t) => {
  const { root, id } = fixture(t);
  exportHandoff(root, id);
  const pending = loadSession(root, id).rounds[0];
  writeFileSync(join(root, sessionRelative(id), "rounds", pending.id, "reply.json"), "unfinished external reply");
  propose(root, "A shared project fact", "source.txt");
  const closed = forceCloseSession(root, id),
    other = createSession(root, "Unrelated task"),
    activePath = join(root, sessionRelative(id)),
    deletedPath = join(root, deletedSessionRelative(id)),
    memoryPath = join(root, ".pi", "pi-waicc", "memory");
  const before = tree(activePath),
    memory = tree(memoryPath),
    source = snapshot(root).fingerprint;
  const deleted = deleteSession(root, id);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.recoverable, true);
  assert.equal(deleted.deletedPath, deletedPath);
  assert.equal(deleted.restoreCommand, `/waicc-restore ${id}`);
  assert.equal(existsSync(activePath), false);
  assert.deepEqual(tree(deletedPath), before);
  assert.deepEqual(loadDeletedSession(root, id), closed);
  assert.throws(() => loadSession(root, id), /Unknown WAICC session/);
  assert.deepEqual(listed(root, "all").sessions.map((s) => s.id), [other.id]);
  assert.deepEqual(listDeletedSessions(root).map((s) => s.id), [id]);
  assert.equal(deleteSession(root, id).alreadyDeleted, true);
  assert.deepEqual(tree(deletedPath), before);
  const restored = restoreSession(root, id);
  assert.equal(restored.status, "CLOSED");
  assert.equal(existsSync(deletedPath), false);
  assert.deepEqual(tree(activePath), before);
  assert.deepEqual(loadSession(root, id), closed);
  assert.equal(listed(root, "all").sessions.length, 2);
  assert.deepEqual(listed(root).sessions.map((s) => s.id), [other.id]);
  assert.deepEqual(listDeletedSessions(root), []);
  assert.deepEqual(loadSession(root, other.id), other);
  assert.deepEqual(tree(memoryPath), memory);
  assert.equal(snapshot(root).fingerprint, source);
  assert.equal(reopenSession(root, id, "Resume intentionally").status, "NEEDS_REVIEW");
});

test("delete rejects open, unknown, cross-project and unsafe targets without moving sessions", (t) => {
  const { root, id } = fixture(t),
    otherProject = fixture(t);
  const before = loadSession(root, id);
  assert.throws(() => deleteSession(root, id), /Only CLOSED/);
  const draft = createSession(root, "Draft objective");
  assert.throws(() => deleteSession(root, draft.id), /Only CLOSED/);
  for (const target of ["../sessions", root, "", "all", otherProject.id])
    assert.throws(() => deleteSession(root, target));
  assert.deepEqual(loadSession(root, id), before);
  assert.deepEqual(loadSession(root, draft.id), draft);
  assert.equal(listSessions(root).length, 2);
  assert.deepEqual(listDeletedSessions(root), []);
});

test("delete and restore share the writer lock and never overwrite an existing directory", (t) => {
  const { root, id } = fixture(t);
  forceCloseSession(root, id);
  withLock(root, () => assert.throws(() => deleteSession(root, id), /locked/));
  const deletedPath = join(root, deletedSessionRelative(id));
  mkdirSync(deletedPath, { recursive: true });
  writeFileSync(join(deletedPath, "sentinel"), "existing recovery data");
  assert.throws(() => deleteSession(root, id), /refusing to overwrite/);
  assert.equal(readFileSync(join(deletedPath, "sentinel"), "utf8"), "existing recovery data");
  // Remove only this fixture's known sentinel directory, not any user data.
  assert.equal(dirname(deletedPath), join(root, ".pi", "pi-waicc", "deleted-sessions"));
  rmSync(deletedPath, { recursive: true });
  deleteSession(root, id);
  withLock(root, () => assert.throws(() => restoreSession(root, id), /locked/));
  const activePath = join(root, sessionRelative(id));
  mkdirSync(activePath);
  writeFileSync(join(activePath, "sentinel"), "existing session data");
  const before = tree(deletedPath);
  assert.throws(() => restoreSession(root, id), /refusing to overwrite/);
  assert.deepEqual(tree(deletedPath), before);
  assert.equal(readFileSync(join(activePath, "sentinel"), "utf8"), "existing session data");
});

test("restore rejects an open session moved into recovery storage out of band", (t) => {
  const { root, id } = fixture(t);
  const target = join(root, deletedSessionRelative(id));
  mkdirSync(dirname(target), { recursive: true });
  renameSync(join(root, sessionRelative(id)), target);
  const before = tree(target);
  assert.throws(() => restoreSession(root, id), /Only deleted CLOSED/);
  assert.deepEqual(tree(target), before);
  assert.equal(existsSync(join(root, sessionRelative(id))), false);
});

test("junctions cannot redirect deletion or restoration outside the intended session stores", (t) => {
  for (const mode of ["delete", "restore"] as const) {
    const { root, id } = fixture(t);
    forceCloseSession(root, id);
    if (mode === "restore") deleteSession(root, id);
    const source = join(root, mode === "delete" ? sessionRelative(id) : deletedSessionRelative(id));
    const outside = join(root, "outside-session-store");
    renameSync(source, outside);
    symlinkSync(outside, source, process.platform === "win32" ? "junction" : "dir");
    const before = tree(outside);
    assert.throws(() => mode === "delete" ? deleteSession(root, id) : restoreSession(root, id), /Symlink\/junction/);
    assert.deepEqual(tree(outside), before);
  }
  const { root, id } = fixture(t);
  forceCloseSession(root, id);
  const outside = join(root, "outside-recovery-store");
  mkdirSync(outside);
  symlinkSync(outside, join(root, ".pi", "pi-waicc", "deleted-sessions"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => deleteSession(root, id), /Symlink\/junction/);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(loadSession(root, id).status, "CLOSED");
});

test("CLI lists open sessions and can delete, discover and restore a closed one", (t) => {
  const { root, id } = fixture(t);
  forceCloseSession(root, id);
  const invoke = (...args: string[]) => JSON.parse(execFileSync(
    process.execPath, [resolve("src/cli.ts"), "--root", root, ...args],
    { encoding: "utf8", windowsHide: true },
  ));
  assert.deepEqual(invoke("list").sessions, []);
  assert.deepEqual(invoke("status").sessions, []);
  assert.equal(invoke("list", "all").sessions[0].id, id);
  assert.equal(invoke("status", "all").sessions[0].id, id);
  assert.equal(invoke("delete", id).recoverable, true);
  assert.deepEqual(invoke("list", "all").sessions, []);
  assert.equal(invoke("list", "deleted").sessions[0].id, id);
  assert.equal(invoke("restore", id).status, "CLOSED");
  assert.equal(invoke("list", "closed").sessions[0].id, id);
  assert.deepEqual(invoke("list").sessions, []);
});
