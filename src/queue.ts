import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join } from "node:path";
import { atomicWrite, json, listSessions, loadSession, now, readJson, runtimePath, withLock } from "./files.ts";
import { killTree, windowsCommand } from "./dispatch.ts";
import { ensure } from "./validation.ts";

/**
 * The overnight queue (/waicc-queue): tasks or issues run one after another, each in its own
 * branch folder and its own headless Pi, as /waicc-planning then /waicc-dispatch --auto --ship.
 * Every question a queued Pi asks is answered no, except the issue you already confirmed when
 * you queued it: so it pushes only when your user file has autoShip, and otherwise stops with
 * the review passed, ready for /waicc-ship.
 */
export interface QueueItem {
  id: number;
  task: string;
  issue: { number: number; title: string } | null;
  status: "waiting" | "running" | "shipped" | "reviewed" | "stopped" | "failed";
  addedAt: string;
  startedAt?: string;
  finishedAt?: string;
  folder?: string;
  branch?: string;
  sessionId?: string;
  url?: string | null;
  outcome?: string;
  /** Where a running task has got to, for /waicc-queue and the tracker page. */
  step?: string;
}
export interface Queue { schemaVersion: 1; items: QueueItem[] }

const queuePath = (root: string) => join(root, runtimePath, "queue.json");
export function readQueue(root: string): Queue {
  return existsSync(queuePath(root)) ? readJson<Queue>(queuePath(root)) : { schemaVersion: 1, items: [] };
}
/** Changes the queue under the project's writer lock. */
export function updateQueue<T>(root: string, change: (queue: Queue) => T): T {
  return withLock(root, () => {
    const queue = readQueue(root);
    const result = change(queue);
    atomicWrite(queuePath(root), json(queue));
    return result;
  });
}
export function addToQueue(root: string, task: string, issue: QueueItem["issue"] = null): QueueItem {
  ensure(task.trim() || issue, "Say what the task is: /waicc-queue add <what you want>, or /waicc-queue add --issue <number>");
  ensure(task.length <= 16_000, "A queued task is at most 16,000 characters");
  return updateQueue(root, (queue) => {
    const item: QueueItem = { id: Math.max(0, ...queue.items.map((i) => i.id)) + 1, task: task.trim(), issue, status: "waiting", addedAt: now() };
    queue.items.push(item);
    return item;
  });
}

/** What a queued Pi reports, one JSON line each, so the queue knows when its run has ended. */
export type QueueEvent =
  | { kind: "loop-ended"; level: string; text: string }
  | { kind: "shipped"; url: string | null; branch: string; sessionId: string }
  | { kind: "pipeline"; outcome: "passed" | "fixing" | "failed" | "ended" | "not-watching"; text: string };
export const queueReportVariable = "WAICC_QUEUE_REPORT";
/** In a queued Pi only (the queue sets the variable): records how its run went. Never fails the caller. */
export function reportRun(event: QueueEvent): void {
  const path = process.env[queueReportVariable];
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ at: now(), ...event })}\n`);
  } catch { /* a report that cannot be written only leaves the queue waiting for its timeout */ }
}

/** A Pi process in RPC mode: commands in, events out (Pi's own protocol). */
export interface RpcPeer {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  kill(): void;
  exited: Promise<number>;
}
export type PiSpawner = (folder: string, env: Record<string, string>, trusted: boolean) => RpcPeer;

const here = fileURLToPath(import.meta.url);
/** The same WAICC as this one, and only it, so a queued run behaves as this chat would. */
export const spawnPi: PiSpawner = (folder, env, trusted) => {
  const args = ["--mode", "rpc", "-ne", "-e", join(dirname(here), `index${extname(here)}`), ...(trusted ? ["-a"] : [])];
  const command = process.platform === "win32" ? windowsCommand("pi", args) : { file: "pi", args, verbatim: false };
  const child = spawn(command.file, command.args, {
    cwd: folder, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    windowsVerbatimArguments: command.verbatim, detached: process.platform !== "win32",
  });
  const listeners: ((line: string) => void)[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) for (const listener of listeners) listener(line);
  });
  child.stderr.resume();
  return {
    write: (line) => child.stdin.write(`${line}\n`),
    onLine: (listener) => void listeners.push(listener),
    kill: () => killTree(child.pid),
    exited: new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)).on("error", () => resolve(1))),
  };
};

export interface RunOptions {
  /** Extra /waicc-dispatch options for every task: --code-with, --plan-with, --review-with. */
  dispatch: string;
  trusted: boolean;
  /** Longest one task may take, with its pipeline and fixes. */
  timeoutMs?: number;
  /** How long the main agent may take to prepare the planning handoff. */
  planningMs?: number;
  spawn?: PiSpawner;
  onProgress?: (item: QueueItem, text: string) => void;
}
export type ItemResult = Pick<QueueItem, "status" | "outcome" | "url" | "sessionId">;

/**
 * Runs one queued task in `folder`: /waicc-planning, then /waicc-dispatch --auto --ship, and waits
 * for the run's end from its report file (and the shipped change's pipeline, when it is watched).
 */
export async function runItem(item: QueueItem, folder: string, reportFile: string, options: RunOptions, signal: AbortSignal): Promise<ItemResult> {
  const peer = (options.spawn ?? spawnPi)(folder, { [queueReportVariable]: reportFile }, options.trusted);
  let n = 0;
  const waiting = new Map<string, (response: any) => void>();
  const events: ((event: any) => void)[] = [];
  const errors: string[] = [];
  peer.onLine((line) => {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "response" && waiting.has(event.id)) return void waiting.get(event.id)!(event), waiting.delete(event.id);
    if (event.type === "extension_ui_request") {
      // Questions: only the issue you confirmed when queueing it gets a yes; all else no.
      if (event.method === "confirm") {
        const yes = Boolean(item.issue) && String(event.title ?? "").startsWith(`Plan from issue #${item.issue!.number}:`);
        peer.write(JSON.stringify({ type: "extension_ui_response", id: event.id, confirmed: yes }));
      } else if (event.method === "select" || event.method === "input" || event.method === "editor")
        peer.write(JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }));
      else if (event.method === "notify" && event.notifyType === "error") errors.push(String(event.message ?? ""));
    }
    for (const listener of [...events]) listener(event);
  });
  const send = (command: object) => new Promise<any>((resolve) => {
    const id = `q${++n}`;
    waiting.set(id, resolve);
    peer.write(JSON.stringify({ ...command, id }));
  });
  const next = (match: (event: any) => boolean, ms: number) => new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => done(false), ms);
    const listener = (event: any) => match(event) && done(true);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      events.splice(events.indexOf(listener), 1);
      resolve(ok);
    };
    events.push(listener);
  });
  const sessions = () => {
    try {
      return listSessions(folder).map((s) => s.id);
    } catch {
      return [];
    }
  };
  // Only a session this run's /waicc-planning made counts, never one already in the folder.
  const earlier = new Set(sessions());
  const lastSession = () => sessions().find((id) => !earlier.has(id));
  const exited = peer.exited.then(() => null);
  try {
    const commands = await Promise.race([send({ type: "get_commands" }), exited]);
    ensure(commands?.data?.commands?.some((c: { name: string }) => c.name === "waicc-queue"), "Pi did not start with WAICC loaded");
    progress(options, item, "planning");
    // The turn's end, or a command error (untrusted folder, unreadable issue) at once.
    const planned = next((event) => event.type === "agent_end" || (event.type === "extension_ui_request" && event.method === "notify" && event.notifyType === "error"), options.planningMs ?? 30 * 60_000);
    await send({ type: "prompt", message: item.issue ? `/waicc-planning --issue ${item.issue.number}${item.task ? ` ${item.task}` : ""}` : `/waicc-planning ${item.task}` });
    const turned = await Promise.race([planned, exited]);
    const sessionId = lastSession();
    const s = sessionId ? loadSession(folder, sessionId) : undefined;
    if (!turned || !s?.rounds.some((r) => r.status === "WAITING" && r.mode === "planning"))
      return { status: "failed", sessionId, url: null, outcome: errors.at(-1) ?? (turned ? "The main agent did not prepare a planning handoff." : "Planning did not finish in time.") };
    progress(options, item, "running: plan, code, review, ship");
    const before = errors.length;
    await send({ type: "prompt", message: `/waicc-dispatch --auto --ship${options.dispatch ? ` ${options.dispatch}` : ""}` });
    // The run's end, from what the queued Pi reports.
    let shipped: string | null | undefined;
    let seen = 0;
    const deadline = Date.now() + (options.timeoutMs ?? 4 * 60 * 60_000);
    for (;;) {
      if (signal.aborted) return { status: "stopped", sessionId, url: shipped ?? null, outcome: "Stopped by you." };
      if (Date.now() > deadline) return { status: shipped !== undefined ? "shipped" : "failed", sessionId, url: shipped ?? null, outcome: "Took longer than the queue allows; stopped." };
      if (errors.length > before && shipped === undefined && !existsSync(reportFile))
        return { status: "failed", sessionId, url: null, outcome: errors.at(-1) };
      const lines = existsSync(reportFile) ? readFileSync(reportFile, "utf8").split(/\r?\n/).filter(Boolean) : [];
      for (const line of lines.slice(seen)) {
        const event = JSON.parse(line) as QueueEvent;
        if (event.kind === "shipped") {
          shipped = event.url;
          progress(options, item, `shipped${event.url ? `: ${event.url}` : ""}; watching its pipeline`);
        } else if (event.kind === "pipeline") {
          if (event.outcome === "fixing") progress(options, item, "pipeline failed; fixing it");
          else return { status: "shipped", sessionId, url: shipped ?? null, outcome: event.text };
        } else if (event.kind === "loop-ended")
          return shipped !== undefined
            ? { status: "shipped", sessionId, url: shipped, outcome: event.text }
            : { status: /Not shipped, as you chose|Nothing was closed/.test(event.text) ? "reviewed" : "stopped", sessionId, url: null, outcome: event.text };
      }
      seen = lines.length;
      if (await Promise.race([new Promise((resolve) => setTimeout(() => resolve(false), 2_000)), exited.then(() => true)]))
        return { status: shipped !== undefined ? "shipped" : "failed", sessionId, url: shipped ?? null, outcome: "The queued Pi exited before its run ended." };
    }
  } finally {
    peer.kill();
  }
}
const progress = (options: RunOptions, item: QueueItem, text: string) => options.onProgress?.(item, text);

/** The report file of one queued task, beside the queue. */
export function reportFileFor(root: string, id: number): string {
  const dir = join(root, runtimePath, "queue");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${id}-${Date.now()}.jsonl`);
}
