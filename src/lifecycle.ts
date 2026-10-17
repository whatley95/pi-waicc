import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import {
  deletedSessionRelative,
  loadDeletedSession,
  loadSession,
  safePath,
  sessionRelative,
  withLock,
} from "./files.ts";
import { projectRoot } from "./source.ts";
import { ensure } from "./validation.ts";

/** Remove one closed session from active storage without erasing its history. */
export function deleteSession(cwd: string, id: string) {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    // Both complete targets are validated before moving anything. Never recurse,
    // follow a junction, overwrite an existing copy, or infer a different session.
    const source = safePath(root, sessionRelative(id));
    const destination = safePath(root, deletedSessionRelative(id));
    const alreadyDeleted = !existsSync(source) && existsSync(destination);
    const session = alreadyDeleted
      ? loadDeletedSession(root, id)
      : loadSession(root, id);
    ensure(
      session.status === "CLOSED",
      "Only CLOSED sessions can be deleted. Close it first with /waicc-force-close <session-id> or normal reviewed closure.",
    );
    if (!alreadyDeleted) {
      ensure(
        !existsSync(destination),
        "A deleted copy already exists; refusing to overwrite it.",
      );
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
    }
    return {
      sessionId: id,
      deleted: true,
      alreadyDeleted,
      recoverable: true,
      historyPreserved: true,
      deletedPath: destination,
      restoreCommand: `/waicc-restore ${id}`,
      message:
        "Closed session removed from session lists. Its complete history is retained in project-local recovery storage; project source and shared memory are unchanged.",
    };
  });
}

/** Restore the original directory and pins, still CLOSED, without selecting it. */
export function restoreSession(cwd: string, id: string) {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const source = safePath(root, deletedSessionRelative(id));
    const destination = safePath(root, sessionRelative(id));
    const session = loadDeletedSession(root, id);
    ensure(
      session.status === "CLOSED",
      "Only deleted CLOSED sessions can be restored.",
    );
    ensure(
      !existsSync(destination),
      "A session with this ID already exists; refusing to overwrite it.",
    );
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(source, destination);
    return {
      sessionId: id,
      restored: true,
      status: session.status,
      historyPreserved: true,
      sessionPath: destination,
      message:
        "Session restored as CLOSED, without changing its history, review verdict or chat selection. Use /waicc-list all to see it, or /waicc-use <session-id> and /waicc-reopen <reason> to resume.",
    };
  });
}
