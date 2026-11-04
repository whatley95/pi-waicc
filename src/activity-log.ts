import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendCapped, waiccVersion } from "./error-log.ts";
import { runtimePath } from "./files.ts";

/**
 * What WAICC did, step by step, kept beside the error log in the project's WAICC folder (ignored
 * by Git): each command, tool call and agent run, when it started and ended, how long it took and
 * how it went. One flow ID ties the steps of one command together, and the error log carries it
 * too, so an error can be traced back to what led to it. Never what anyone wrote: names, IDs,
 * numbers and outcomes only.
 */
export const activityLogName = "activity.jsonl";
/** Past this size the oldest half is dropped, so the file stays small. */
export const activityLogLimit = 512 * 1024;

/** A short value describing a step: a mode, an agent, a model, a token count. Never free text. */
export type ActivityDetail = Record<string, string | number | boolean | null>;
export interface ActivityEntry {
  at: string;
  /** One command or run: every step it led to has the same flow. */
  flow: string;
  /** What ran: "/waicc-dispatch", "waicc_prepare", "dispatch", "waicc continue", ... */
  step: string;
  /** A start without an end is a step that never finished (Pi closed, or it hung). */
  phase: "start" | "end";
  /** On an end: how long the step took. */
  ms?: number;
  /** On an end: "ok", "error", or the step's own result ("reply", "no-reply", "stopped", ...). */
  outcome?: string;
  version?: string;
  chat?: string;
  sessionId?: string;
  detail?: ActivityDetail;
}
export type ActivityContext = Pick<ActivityEntry, "chat" | "sessionId" | "detail">;

export const newFlow = (): string => randomBytes(4).toString("hex");

/** Keeps short scalar values only: a long string is cut, anything else is dropped. */
function scalars(detail: ActivityDetail): ActivityDetail {
  return Object.fromEntries(Object.entries(detail).slice(0, 20).flatMap(([name, value]): [string, ActivityDetail[string]][] =>
    value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? [[name.slice(0, 40), value]]
      : typeof value === "string" ? [[name.slice(0, 40), value.slice(0, 120)]] : []));
}

/** Only in a project that already has its WAICC folder; never fails the caller. */
export function recordActivity(root: string, entry: Omit<ActivityEntry, "at" | "version">): void {
  try {
    const folder = join(root, runtimePath);
    if (!existsSync(folder)) return;
    const { chat, sessionId, detail, ms, outcome } = entry;
    const line: ActivityEntry = {
      at: new Date().toISOString(), flow: entry.flow.slice(0, 40), step: entry.step.slice(0, 80), phase: entry.phase,
      ...(ms === undefined ? {} : { ms: Math.max(0, Math.round(ms)) }),
      ...(outcome ? { outcome: outcome.slice(0, 40) } : {}),
      version: waiccVersion(),
      ...(chat ? { chat: chat.slice(0, 80) } : {}),
      ...(sessionId ? { sessionId: sessionId.slice(0, 80) } : {}),
      ...(detail && Object.keys(detail).length ? { detail: scalars(detail) } : {}),
    };
    appendCapped(join(folder, activityLogName), JSON.stringify(line), activityLogLimit);
  } catch { /* the log only helps later; it must never turn into an error of its own */ }
}

/** Records a step's start, and returns what records its end with the time it took. */
export function startActivity(root: string, flow: string, step: string, context: ActivityContext = {}) {
  const startedAt = Date.now();
  recordActivity(root, { flow, step, phase: "start", ...context });
  let ended = false;
  return (outcome: string, more: ActivityContext = {}): void => {
    if (ended) return;
    ended = true;
    recordActivity(root, { flow, step, phase: "end", ms: Date.now() - startedAt, outcome, ...context, ...more,
      detail: { ...context.detail, ...more.detail } });
  };
}

export function readActivity(root: string): ActivityEntry[] {
  const path = join(root, runtimePath, activityLogName);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as ActivityEntry] : [];
    } catch {
      return [];
    }
  });
}

export interface StepSummary {
  step: string;
  /** Ended runs of this step. */
  runs: number;
  /** Of those, how many ended other than "ok", "reply" or "passed", by outcome. */
  failed: number;
  outcomes: Record<string, number>;
  averageMs: number;
  maxMs: number;
  /** Started and not ended: still running, or Pi closed or it hung before it could end. */
  unfinished: number;
}
const good = new Set(["ok", "reply", "passed"]);
/** Per step, slowest total first: where time goes, what fails, and what never finishes. */
export function summarizeActivity(entries: ActivityEntry[]): StepSummary[] {
  const steps = new Map<string, StepSummary & { totalMs: number }>();
  const open = new Map<string, number>();
  const of = (step: string) => {
    let row = steps.get(step);
    if (!row) steps.set(step, row = { step, runs: 0, failed: 0, outcomes: {}, averageMs: 0, maxMs: 0, unfinished: 0, totalMs: 0 });
    return row;
  };
  for (const entry of entries) {
    const row = of(entry.step), id = `${entry.flow}\0${entry.step}`;
    if (entry.phase === "start") {
      open.set(id, (open.get(id) ?? 0) + 1);
      continue;
    }
    if (open.get(id)) open.set(id, open.get(id)! - 1);
    const outcome = entry.outcome ?? "ok", ms = entry.ms ?? 0;
    row.runs++;
    row.outcomes[outcome] = (row.outcomes[outcome] ?? 0) + 1;
    if (!good.has(outcome)) row.failed++;
    row.totalMs += ms;
    row.maxMs = Math.max(row.maxMs, ms);
  }
  for (const [id, count] of open) if (count) of(id.split("\0")[1]).unfinished += count;
  return [...steps.values()].sort((a, b) => b.totalMs - a.totalMs || a.step.localeCompare(b.step))
    .map(({ totalMs, ...row }) => ({ ...row, averageMs: row.runs ? Math.round(totalMs / row.runs) : 0 }));
}
