import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { json, now, runtimePath } from "./files.ts";
import { projectRoot } from "./source.ts";
import { ensure, identifier } from "./validation.ts";

/**
 * A dispatch that runs on after the command that started it: `waicc dispatch <session> --detach`
 * starts the same dispatch in a process of its own and returns at once. A host with no process
 * of its own to wait in (Claude Code's mod) reads this record to show it and to say when it ends.
 */
export interface BackgroundRun {
  sessionId: string;
  pid: number;
  startedAt: string;
  /** The dispatch's own options, as typed after the session. */
  args: string[];
  /** Its live steps and any error, as the foreground command prints them. */
  log: string;
  endedAt?: string;
  /** reply: the agent submitted one; no-reply: it ended without; error: the dispatch failed. */
  outcome?: "reply" | "no-reply" | "error";
  /** What to tell the human about the end. */
  message?: string;
}

const runPath = (root: string, id: string) => join(root, runtimePath, "runs", `${identifier(id, "Session ID")}.json`);

export function backgroundRun(cwd: string, id: string): BackgroundRun | null {
  const path = runPath(projectRoot(cwd), id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BackgroundRun;
  } catch {
    return null;
  }
}

/** Whether its process still runs: a run whose process is gone without an end record was killed. */
export function stillRunning(run: BackgroundRun): boolean {
  if (run.endedAt) return false;
  try {
    process.kill(run.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Starts `waicc dispatch <id> <args>` in its own process; the caller has checked the options. */
export function startBackgroundDispatch(cwd: string, id: string, args: string[]): BackgroundRun {
  const root = projectRoot(cwd);
  const previous = backgroundRun(root, id);
  ensure(!previous || !stillRunning(previous), `A dispatch for this session is already running (process ${previous?.pid}, since ${previous?.startedAt}). Wait for it, or stop it first.`);
  const path = runPath(root, id);
  mkdirSync(dirname(path), { recursive: true });
  const log = path.replace(/\.json$/, ".log");
  const out = openSync(log, "w");
  try {
    const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
    const child = spawn(process.execPath, [cli, "--root", root, "dispatch", id, ...args, "--background-run"], {
      cwd: root, detached: true, stdio: ["ignore", out, out], windowsHide: true,
    });
    child.unref();
    const run: BackgroundRun = { sessionId: id, pid: child.pid ?? 0, startedAt: now(), args, log };
    writeFileSync(path, json(run));
    return run;
  } finally {
    closeSync(out);
  }
}

/** The background process's own end: what the host tells the human. */
export function finishBackgroundRun(cwd: string, id: string, end: Required<Pick<BackgroundRun, "outcome" | "message">>): void {
  const root = projectRoot(cwd);
  const run = backgroundRun(root, id);
  if (!run || run.pid !== process.pid) return;
  writeFileSync(runPath(root, id), json({ ...run, endedAt: now(), ...end }));
}
