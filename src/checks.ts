import { randomUUID } from "node:crypto";
import { json, loadSession, now, withLock } from "./files.ts";
import { commitWithCheckpoint as commit } from "./checkpoint.ts";
import { assertRecipientCurrent } from "./recipient.ts";
import { roundDirectory } from "./render.ts";
import { projectRoot, snapshot } from "./source.ts";
import { ensure, list, record, text } from "./validation.ts";
import type { RecipientPin } from "./types.ts";

export interface CheckCommand {
  program: string;
  args: string[];
  timeoutMs: number;
}
export interface CheckResult {
  stdout: string; stderr: string; code: number; killed: boolean;
}
export type CheckRunner = (program: string, args: string[], options: {
  cwd: string; timeout: number; signal?: AbortSignal;
}) => Promise<CheckResult>;

/** Interactive checks run up to a minute; checks a human pre-approves at dispatch may run longer. */
export function checkCommand(value: unknown, maxTimeoutMs = 60_000): CheckCommand {
  const command = record(value, "Check command");
  ensure(Object.keys(command).every((key) => ["program", "args", "timeoutMs"].includes(key)), "Unsupported check command field");
  const program = text(command.program, "Check executable", 2000);
  ensure(!/[\x00-\x1f]/.test(program), "Invalid check executable");
  const args = list(command.args, "Check arguments", 100).map((arg) => {
    ensure(typeof arg === "string" && arg.length <= 8000 && !arg.includes("\0"), "Invalid check argument");
    return arg;
  });
  const timeoutMs = command.timeoutMs ?? 60_000;
  ensure(Number.isInteger(timeoutMs) && Number(timeoutMs) >= 1000 && Number(timeoutMs) <= maxTimeoutMs, `Check timeout must be 1000–${maxTimeoutMs} ms`);
  return { program, args, timeoutMs: Number(timeoutMs) };
}

/** Called only after explicit recipient opt-in AND confirmation of this exact command, or
 * when the human pre-approved this exact command when dispatching. `workdir` runs it in an
 * isolated worktree instead of the project. */
export async function runRecipientCheck(
  cwd: string, pin: RecipientPin, command: CheckCommand,
  approvedSource: string, run: CheckRunner, signal?: AbortSignal,
  options: { maxTimeoutMs?: number; workdir?: string } = {},
) {
  const root = projectRoot(cwd);
  command = checkCommand(command, options.maxTimeoutMs);
  ensure(["implementation", "testing", "review"].includes(pin.mode), "Only implementation, testing and (pre-approved) review recipients may run checks");
  // Testers and reviewers are read-only: their source must stay exactly as handed off.
  const readOnly = pin.mode === "testing" || pin.mode === "review";
  signal?.throwIfAborted();
  const id = randomUUID(), startedAt = now();
  const prefix = withLock(root, () => {
    assertRecipientCurrent(root, pin);
    const s = loadSession(root, pin.sessionId), r = s.rounds.find((round) => round.id === pin.requestId)!;
    ensure(snapshot(root).fingerprint === approvedSource, "Source changed while the command was being approved; confirm a fresh command against the new source");
    if (readOnly) ensure(approvedSource === pin.sourceFingerprint, `${pin.mode === "review" ? "Reviewed" : "Testing"} source changed; request a fresh handoff`);
    const path = `${roundDirectory(r)}/checks/${id}`;
    commit(root, s, "check.started-after-human-confirmation", {
      [`${path}/start.json`]: json({ schemaVersion: 1, ...pin, command, startedAt, sourceBefore: approvedSource }),
    });
    return path;
  });
  let result: CheckResult;
  try {
    result = await run(command.program, command.args, { cwd: options.workdir ?? root, timeout: command.timeoutMs, signal });
  } catch (error) {
    result = { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1, killed: Boolean(signal?.aborted) };
  }
  const sourceAfter = snapshot(root).fingerprint;
  const sourceChanged = sourceAfter !== approvedSource;
  const report = {
    schemaVersion: 1, ...pin, command, startedAt, finishedAt: now(),
    ...(options.workdir ? { ranIn: "isolated worktree" } : {}),
    sourceBefore: approvedSource, sourceAfter, sourceChanged,
    outcome: result.code === 0 && !result.killed && !(readOnly && sourceChanged) ? "passed" : "failed",
    code: result.code, killed: result.killed,
    stdout: result.stdout.slice(0, 24_000), stderr: result.stderr.slice(0, 24_000),
    outputTruncated: result.stdout.length > 24_000 || result.stderr.length > 24_000,
  };
  const artifactPath = `${prefix}/result.json`;
  const saved = withLock(root, () => {
    const s = loadSession(root, pin.sessionId);
    // A process already running cannot be revoked by changing a contract. Preserve
    // CLOSED history and never retarget the result to another assignment.
    if (s.status === "CLOSED") return false;
    commit(root, s, "check.finished", { [artifactPath]: json(report) });
    return true;
  });
  return {
    artifactPath: saved ? artifactPath : null, ...report,
    nextAction: readOnly && sourceChanged
      ? "STOP: the check changed reviewed source. No changes were reverted. Return to the coordinator to inspect changes and issue a fresh handoff."
      : saved ? "Inspect actual output and limits; cite this result in reply checks. A check exit code is not whole-work completion or review PASS."
        : "Contract was closed while the check ran. Stop; no result was added to closed history.",
  };
}
