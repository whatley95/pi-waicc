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
export function loadSession(root: string, id: string): Session {
  const path = safePath(root, `${sessionRelative(id)}/journal`);
  const commits = readdirSync(path)
    .filter((name) => /^\d{8}-[a-f0-9-]+\.json$/.test(name))
    .sort();
  ensure(commits.length > 0, "Session has no committed transactions");
  const entry = readJson<{ schemaVersion: number; session: Session }>(
    safePath(root, `${sessionRelative(id)}/journal/${commits.at(-1)!}`),
    32_000_000,
  );
  const s = entry.session;
  ensure(
    entry.schemaVersion === 1 &&
      s.schemaVersion === 1 &&
      s.id === id &&
      s.projectRoot === realpathSync(root),
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
  const name = `${String(s.sequence).padStart(8, "0")}-${randomUUID()}.json`;
  const path = safePath(root, `${sessionRelative(s.id)}/journal/${name}`);
  atomicWrite(path, json({ schemaVersion: 1, at: now(), event, session: s }));
  // Failure of this cache cannot roll back a journal entry already committed.
  try {
    atomicWrite(
      safePath(root, `${sessionRelative(s.id)}/session.json`),
      json(s),
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
export function listSessions(
  root: string,
): { id: string; status: string; createdAt: string }[] {
  const path = safePath(root, `${runtimePath}/sessions`);
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => /^[a-f0-9-]{36}$/.test(name))
    .filter((id) => {
      const journal = safePath(root, `${sessionRelative(id)}/journal`);
      return (
        existsSync(journal) &&
        readdirSync(journal).some((file) =>
          /^\d{8}-[a-f0-9-]+\.json$/.test(file),
        )
      );
    })
    .map((id) => {
      const s = loadSession(root, id);
      return { id, status: s.status, createdAt: s.createdAt };
    });
}
