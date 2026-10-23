import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { ensure, identifier } from "./validation.ts";
import type { Session } from "./types.ts";

export const digest = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");
export const json = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
export const now = (): string => new Date().toISOString();
export const runtimePath = ".pi/pi-waicc";

/** Every existing component is inspected. Junctions/symlinks are not write grants. */
/** One spelling per directory: native resolution also expands Windows 8.3 short names
 * (C:\Users\NAME~1) and fixes letter case, which a JavaScript realpath leaves alone. */
export const canonicalPath = (path: string): string => realpathSync.native(path);

/** Whether two paths name the same directory, however each is spelled. */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return canonicalPath(a) === canonicalPath(b);
  } catch {
    return false;
  }
}

export function safePath(root: string, child: string): string {
  ensure(
    !isAbsolute(child) && !/^[A-Za-z]:|[\x00-\x1f]/.test(child),
    "Invalid storage path",
  );
  const parts = child.replaceAll("\\", "/").split("/");
  ensure(
    parts.every(
      (part) => part && part !== "." && part !== ".." && !part.includes(":"),
    ),
    "Invalid storage path component",
  );
  const target = resolve(root, ...parts);
  const rel = relative(root, target);
  ensure(
    rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel),
    "Path escapes root",
  );
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (existsSync(current))
      ensure(
        !lstatSync(current).isSymbolicLink(),
        `Symlink/junction is not allowed: ${current}`,
      );
    else {
      // existsSync follows links, including broken ones. lstat catches those too.
      try {
        ensure(
          !lstatSync(current).isSymbolicLink(),
          `Broken symlink is not allowed: ${current}`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return target;
}
export function readText(path: string, maxBytes = 1_048_576): string {
  const stat = lstatSync(path);
  ensure(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes,
    `Not a regular file or exceeds ${maxBytes} bytes: ${path}`,
  );
  return readFileSync(path, "utf8");
}
export function readJson<T>(path: string, maxBytes?: number): T {
  return JSON.parse(readText(path, maxBytes)) as T;
}
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}
export function exclusiveWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function initialize(root: string): void {
  mkdirSync(safePath(root, runtimePath), { recursive: true });
  const ignore = safePath(root, `${runtimePath}/.gitignore`);
  if (!existsSync(ignore)) exclusiveWrite(ignore, "*\n");
}
export function withLock<T>(root: string, action: () => T): T {
  initialize(root);
  const path = safePath(root, `${runtimePath}/write.lock`);
  try {
    exclusiveWrite(
      path,
      json({ pid: process.pid, hostname: hostname(), createdAt: now() }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "WAICC is locked by another writer or an interrupted process. Run waicc recover-lock after checking its owner.",
      );
    throw error;
  }
  try {
    return action();
  } finally {
    unlinkSync(path);
  }
}
export function recoverLock(root: string): void {
  const path = safePath(root, `${runtimePath}/write.lock`);
  const lock = readJson<{ pid: number; hostname: string }>(path);
  ensure(
    lock.hostname === hostname() &&
      Number.isSafeInteger(lock.pid) &&
      lock.pid > 0,
    "Cannot establish lock ownership on this machine",
  );
  try {
    process.kill(lock.pid, 0);
    throw new Error(`Lock owner PID ${lock.pid} is still running`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  renameSync(
    path,
    safePath(root, `${runtimePath}/recovered-lock-${randomUUID()}.json`),
  );
}
export const sessionRelative = (id: string): string =>
  `${runtimePath}/sessions/${identifier(id, "Session ID")}`;
export const deletedSessionRelative = (id: string): string =>
  `${runtimePath}/deleted-sessions/${identifier(id, "Session ID")}`;
/**
 * Source snapshots are stored once each, by the digest of their file map, beside the journal.
 * Every journal entry is the whole session, and each round keeps its own snapshot (two for a
 * code review), so in a large project inline copies made each entry megabytes larger per round.
 */
const snapshotRelative = (directory: string, ref: string): string => `${directory}/snapshots/${ref}.json`;
const isSnapshot = (value: any): boolean =>
  Boolean(value) && typeof value === "object" && typeof value.vcs === "string" && typeof value.fingerprint === "string" &&
  Boolean(value.files) && typeof value.files === "object" && !Array.isArray(value.files);
/** File maps by digest, frozen: content-addressed, so shared by every session that loads them. */
const snapshotFiles = new Map<string, Record<string, string>>();
function storedFiles(root: string, directory: string, ref: string): Record<string, string> {
  let files = snapshotFiles.get(ref);
  if (!files) {
    ensure(/^[a-f0-9]{64}$/.test(ref), "Invalid source snapshot reference");
    const content = readText(safePath(root, snapshotRelative(directory, ref)), 128_000_000);
    ensure(digest(content) === ref, `Source snapshot ${ref} was modified`);
    files = Object.freeze(JSON.parse(content) as Record<string, string>);
    snapshotFiles.set(ref, files);
    if (snapshotFiles.size > 48) snapshotFiles.delete(snapshotFiles.keys().next().value!);
  }
  return files;
}
/** The session as stored: each snapshot's files replaced by a reference, written first if new. */
function storedSession(root: string, id: string, value: unknown): string {
  return `${JSON.stringify(value, (_key, v) => {
    if (!isSnapshot(v)) return v;
    const content = JSON.stringify(v.files);
    const ref = digest(content);
    const path = safePath(root, snapshotRelative(sessionRelative(id), ref));
    if (!existsSync(path)) atomicWrite(path, content);
    const { files: _files, ...rest } = v;
    return { ...rest, filesRef: ref };
  }, 2)}\n`;
}
/** Puts each referenced file map back, wherever it is; entries written before snapshots were stored apart carry them inline. */
function loadedSnapshots(root: string, directory: string, value: any): void {
  if (!value || typeof value !== "object") return;
  if (typeof value.filesRef === "string" && typeof value.fingerprint === "string") {
    value.files = storedFiles(root, directory, value.filesRef);
    delete value.filesRef;
    return;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) loadedSnapshots(root, directory, child);
}
export function loadSession(root: string, id: string): Session {
  return loadStoredSession(root, id, false);
}
export function loadDeletedSession(root: string, id: string): Session {
  return loadStoredSession(root, id, true);
}
function loadStoredSession(root: string, id: string, deleted: boolean): Session {
  const directory = deleted ? deletedSessionRelative(id) : sessionRelative(id);
  const path = safePath(root, `${directory}/journal`);
  ensure(
    existsSync(path),
    deleted
      ? `Unknown deleted WAICC session ${id}. List recovery storage with /waicc-list deleted (CLI: list deleted).`
      : `Unknown WAICC session ${id}. List sessions with /waicc-status all (CLI: status all); use /waicc-list deleted to find deleted sessions.`,
  );
  const commits = readdirSync(path)
    .filter((name) => /^\d{8}-[a-f0-9-]+\.json$/.test(name))
    .sort();
  ensure(commits.length > 0, "Session has no committed transactions");
  const entry = readJson<{
    schemaVersion: number;
    at: string;
    session: Session;
  }>(
    safePath(root, `${directory}/journal/${commits.at(-1)!}`),
    // Large for entries written with every snapshot inline; the next commit stores them apart.
    256_000_000,
  );
  const s = entry.session;
  loadedSnapshots(root, directory, s);
  ensure(
    entry.schemaVersion === 1 &&
      s.schemaVersion === 1 &&
      s.id === id &&
      // Sessions saved under another spelling of the same directory (8.3 name, case) still load.
      samePath(s.projectRoot, root),
    "Session identity, location or schema mismatch",
  );
  ensure(
    s.sequence === Number(commits.at(-1)!.slice(0, 8)),
    "Invalid journal sequence",
  );
  ensure(
    s.verified === false &&
      Number.isInteger(s.contractVersion) &&
      s.contractVersion >= 0 &&
      Array.isArray(s.rounds) &&
      Array.isArray(s.requirements),
    "Invalid session state",
  );
  s.rounds.forEach((r) => identifier(r.id, "Request ID"));
  ensure(
    typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)),
    "Invalid journal activity timestamp",
  );
  // The journal is authoritative, including for older sessions without updatedAt.
  s.updatedAt = entry.at;
  // Old handoff-ready sessions are not silently promoted to a closure-ready PASS.
  s.contractReview ??= "NOT_REVIEWED";
  s.deliveryVerified ??= false;
  ensure(
    [
      "NOT_REVIEWED",
      "PENDING",
      "PASS",
      "NEEDS_CHANGES",
      "BLOCKED",
      "STALE",
    ].includes(s.contractReview) && s.deliveryVerified === false,
    "Invalid contract review or delivery verification state",
  );
  return s;
}
/** Journal entry is the commit point; session.json is a disposable UI cache. */
export function commit(
  root: string,
  session: Session,
  event: string,
  files: Record<string, string> = {},
): Session {
  const s = structuredClone(session);
  for (const [path, content] of Object.entries(files)) {
    const destination = safePath(root, `${sessionRelative(s.id)}/${path}`);
    ensure(
      !Object.hasOwn(s.artifacts, path),
      `Cannot overwrite a committed artifact: ${path}`,
    );
    // A crash before the journal commit can leave orphaned files. They have no
    // committed owner and may be replaced while holding the project writer lock.
    if (existsSync(destination)) atomicWrite(destination, content);
    else exclusiveWrite(destination, content);
    s.artifacts[path] = digest(content);
  }
  s.sequence++;
  s.updatedAt = now();
  const name = `${String(s.sequence).padStart(8, "0")}-${randomUUID()}.json`;
  const path = safePath(root, `${sessionRelative(s.id)}/journal/${name}`);
  atomicWrite(
    path,
    storedSession(root, s.id, { schemaVersion: 1, at: s.updatedAt, event, session: s }),
  );
  // Failure of this cache cannot roll back a journal entry already committed.
  try {
    atomicWrite(
      safePath(root, `${sessionRelative(s.id)}/session.json`),
      storedSession(root, s.id, s),
    );
  } catch {
    /* recovered from journal on next read */
  }
  return s;
}
export function artifact(root: string, session: Session, path: string): string {
  const content = readText(
    safePath(root, `${sessionRelative(session.id)}/${path}`),
    8_000_000,
  );
  ensure(
    session.artifacts[path] === digest(content),
    `Artifact was modified or is not committed: ${path}`,
  );
  return content;
}
interface SessionSummary {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  contractReview: Session["contractReview"];
  deliveryVerified: false;
}
export function listSessions(root: string): SessionSummary[] {
  return storedSessions(root, false);
}
export function listDeletedSessions(root: string): SessionSummary[] {
  return storedSessions(root, true);
}
function storedSessions(root: string, deleted: boolean): SessionSummary[] {
  const path = safePath(
    root,
    `${runtimePath}/${deleted ? "deleted-sessions" : "sessions"}`,
  );
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => /^[a-f0-9-]{36}$/.test(name))
    .filter((id) => {
      const directory = deleted ? deletedSessionRelative(id) : sessionRelative(id);
      const journal = safePath(root, `${directory}/journal`);
      return (
        existsSync(journal) &&
        readdirSync(journal).some((file) =>
          /^\d{8}-[a-f0-9-]+\.json$/.test(file),
        )
      );
    })
    .map((id) => {
      const s = deleted ? loadDeletedSession(root, id) : loadSession(root, id);
      return {
        id,
        status: s.status,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        contractReview: s.contractReview,
        deliveryVerified: s.deliveryVerified,
      };
    })
    .sort(
      (a, b) =>
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
}
