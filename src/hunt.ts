import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { json, now, runtimePath, safePath, withLock } from "./files.ts";
import { askReadOnly } from "./consult.ts";
import { runAgent, type AgentRunner, type DispatchOptions } from "./dispatch.ts";
import type { ProgressEvent } from "./progress.ts";
import { changedFiles, projectRoot, snapshot } from "./source.ts";
import { ensure, text } from "./validation.ts";

/**
 * A bug hunt: the main agent reads a scope read-only and reports candidate bugs, the advisor
 * triages them, and the human picks which ones become the requirements of a planning session.
 */
export type Severity = "high" | "medium" | "low";
export type Verdict = "confirmed" | "plausible" | "not a bug" | "untriaged";
export interface Bug {
  id: string;
  file: string;
  line: number;
  trigger: string;
  wrong: string;
  severity: Severity;
  verdict: Verdict;
  reason?: string;
}
export interface Hunt {
  schemaVersion: 1;
  id: string;
  scope: string;
  startedAt: string;
  status: "SCANNING" | "TRIAGED" | "PICKED";
  /** The source when the scan started: a report is refused if it changed, so a scan stays a scan. */
  source: { fingerprint: string; files: Record<string, string> };
  bugs: Bug[];
  reportedAt?: string;
  triage?: { by: string | null; answer: string | null; durationMs: number; note?: string };
  sessionId?: string;
}
/** Candidates per report: more makes triage slow and the pick hard to read. */
export const huntLimit = 15;
/** Above this many picked bugs, one session is suggested to be split. */
export const pickSplitAt = 10;
const severities: Severity[] = ["high", "medium", "low"];

const huntPath = (id: string) => `${runtimePath}/hunts/${id}/hunt.json`;

function save(root: string, hunt: Hunt): Hunt {
  const path = safePath(root, huntPath(hunt.id));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json(hunt));
  return hunt;
}
export function loadHunt(cwd: string, id: string): Hunt {
  const root = projectRoot(cwd);
  ensure(/^[0-9a-f-]{36}$/.test(id), `No bug hunt ${JSON.stringify(id)}`);
  const path = safePath(root, huntPath(id));
  ensure(existsSync(path), `No bug hunt ${id} in this project`);
  return JSON.parse(readFileSync(path, "utf8")) as Hunt;
}
/** This project's hunts, newest first. */
export function listHunts(cwd: string): Hunt[] {
  const root = projectRoot(cwd);
  const folder = safePath(root, `${runtimePath}/hunts`);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((id) => existsSync(safePath(root, huntPath(id)))).map((id) => loadHunt(root, id))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function startHunt(cwd: string, scope: string): Hunt {
  const root = projectRoot(cwd);
  ensure(scope.trim(), "Usage: /waicc-bug-hunt <scope>, for example /waicc-bug-hunt src/payments, or /waicc-bug-hunt . for the whole project");
  const what = text(scope, "Scope", 500).trim();
  const source = snapshot(root);
  return withLock(root, () => save(root, {
    schemaVersion: 1, id: randomUUID(), scope: what, startedAt: now(), status: "SCANNING",
    source: { fingerprint: source.fingerprint, files: source.files }, bugs: [],
  }));
}

/** A project-relative path with forward slashes, from whatever the agent wrote. */
function relativeFile(root: string, file: string): string {
  const path = isAbsolute(file) ? relative(root, file) : file;
  return path.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
}

/** The main agent's candidates, checked one by one; every problem is named at once. */
export function reportBugs(cwd: string, id: string, input: unknown): Hunt {
  const root = projectRoot(cwd);
  return withLock(root, () => {
    const hunt = loadHunt(root, id);
    ensure(hunt.status === "SCANNING", `Bug hunt ${id} was already reported; start a new one with /waicc-bug-hunt <scope>`);
    const after = snapshot(root);
    ensure(after.fingerprint === hunt.source.fingerprint,
      `The source changed during the bug hunt, so this is no longer a read-only scan.${changedFiles(hunt.source.files, after)} Restore those files, or start a new hunt with /waicc-bug-hunt ${hunt.scope}.`);
    ensure(Array.isArray(input), "bugs must be a list; an empty list means none were found");
    ensure(input.length <= huntLimit, `At most ${huntLimit} bugs per hunt: keep the most severe ${huntLimit}, or narrow the scope`);
    const problems: string[] = [];
    const bugs = input.map((raw, i): Bug => {
      const b = (raw ?? {}) as Record<string, unknown>;
      const at = `bugs[${i}]`;
      const field = (name: string) => (typeof b[name] === "string" ? (b[name] as string).trim() : "");
      const file = field("file") ? relativeFile(root, field("file")) : "";
      if (!file) problems.push(`${at}.file: name the file`);
      else {
        let found = false;
        try { found = existsSync(safePath(root, file)); } catch { /* outside the project */ }
        if (!found) problems.push(`${at}.file: ${file} is not a file in this project`);
      }
      if (!Number.isInteger(b.line) || (b.line as number) < 1) problems.push(`${at}.line: give the line number, 1 or more`);
      for (const [name, what] of [["trigger", "the input or state that triggers it"], ["wrong", "what goes wrong"]] as const) {
        if (!field(name)) problems.push(`${at}.${name}: say ${what}`);
        else if (field(name).length > 2_000) problems.push(`${at}.${name}: at most 2000 characters`);
      }
      if (!severities.includes(b.severity as Severity)) problems.push(`${at}.severity: high, medium or low`);
      return { id: `B${i + 1}`, file, line: b.line as number, trigger: field("trigger"), wrong: field("wrong"), severity: b.severity as Severity, verdict: "untriaged" };
    });
    ensure(!problems.length, `${problems.length} problem${problems.length > 1 ? "s" : ""}; fix all of them:\n${problems.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
    return save(root, { ...hunt, bugs, reportedAt: now() });
  });
}

/** The candidates as the advisor reads them. */
export function candidatesText(hunt: Hunt): string {
  return `# Candidate bugs\n\nScope: ${hunt.scope}\n\n${hunt.bugs.map((b) =>
    `## ${b.id} (${b.severity}) ${b.file}:${b.line}\n\nTrigger: ${b.trigger}\n\nWhat goes wrong: ${b.wrong}\n`).join("\n")}`;
}

/** `B1 | confirmed | reason` lines from the advisor's answer; anything else is ignored. */
export function parseTriage(answer: string): Map<string, { verdict: Exclude<Verdict, "untriaged">; reason: string }> {
  const verdicts = new Map<string, { verdict: Exclude<Verdict, "untriaged">; reason: string }>();
  for (const line of answer.split(/\r?\n/)) {
    const m = /^[\s>*-]*`?(B\d+)`?\s*\|\s*\**(confirmed|plausible|not a bug|not-a-bug)\**\s*\|\s*(.*)$/i.exec(line);
    if (m && !verdicts.has(m[1].toUpperCase()))
      verdicts.set(m[1].toUpperCase(), { verdict: m[2].toLowerCase() === "not-a-bug" ? "not a bug" : m[2].toLowerCase() as "confirmed" | "plausible" | "not a bug", reason: m[3].trim() });
  }
  return verdicts;
}

/**
 * The advisor checks every candidate in one run. With no advisor, or no answer, the bugs stay
 * untriaged and the human judges them alone.
 */
export async function triageBugs(cwd: string, id: string, advisor: { profile: string; options: DispatchOptions } | null,
  run: AgentRunner = runAgent, signal?: AbortSignal, onProgress?: (event: ProgressEvent) => void): Promise<Hunt> {
  const root = projectRoot(cwd);
  const hunt = loadHunt(root, id);
  ensure(hunt.status === "SCANNING" && hunt.reportedAt, `Bug hunt ${id} has no report to triage`);
  const done = (bugs: Bug[], triage: NonNullable<Hunt["triage"]>) =>
    withLock(root, () => save(root, { ...loadHunt(root, id), bugs, triage, status: "TRIAGED" }));
  if (!hunt.bugs.length) return done([], { by: null, answer: null, durationMs: 0, note: "No bugs were reported." });
  if (!advisor) return done(hunt.bugs, { by: null, answer: null, durationMs: 0, note: "No advisor role is set, so nobody checked these." });
  const listPath = safePath(root, `${runtimePath}/hunts/${id}/candidates.md`);
  writeFileSync(listPath, candidatesText(hunt));
  // One line: it travels as a command-line argument on every platform.
  const prompt = `You are a senior engineer checking another coding agent's bug report for the project at ${JSON.stringify(root)}. Read the candidate bugs at ${JSON.stringify(listPath)}. For each one, read the cited code yourself, read-only: never edit, create or delete files, and run nothing that changes state. Decide whether the stated trigger really produces the stated wrong result: confirmed (it does, and you can point to why), plausible (it may, but it depends on something you cannot settle from the source) or not a bug (it cannot happen, or the behaviour is intended). Answer with exactly one line per candidate, in this form and nothing else on those lines: B1 | confirmed | the reason in one sentence, citing file:line. Give every candidate a line. Be strict: a wrong confirmation costs a needless fix.`;
  const outcome = await askReadOnly(root, prompt, advisor.options, run, signal, onProgress);
  const verdicts = parseTriage(outcome.answer ?? "");
  const missing = hunt.bugs.filter((b) => !verdicts.has(b.id)).map((b) => b.id);
  return done(
    hunt.bugs.map((b) => ({ ...b, ...verdicts.get(b.id) })),
    {
      by: advisor.profile, answer: outcome.answer, durationMs: outcome.durationMs,
      ...(outcome.answer ? missing.length ? { note: `The advisor gave no verdict on ${missing.join(", ")}.` } : {}
        : { note: `The advisor gave no answer (exit ${outcome.code}${outcome.killed ? ", stopped" : ""}), so nobody checked these.` }),
    },
  );
}

/** The triaged list as the human reads it, with how to pick. */
export function huntTable(hunt: Hunt): string {
  if (!hunt.bugs.length) return `Bug hunt over ${hunt.scope}: no bugs were reported. Nothing to pick.`;
  const rows = hunt.bugs.map((b) => `| ${b.id} | ${b.verdict} | ${b.severity} | ${b.file}:${b.line} | ${b.wrong.replace(/\s+/g, " ").replaceAll("|", "\\|").slice(0, 160)} | ${(b.reason ?? "").replace(/\s+/g, " ").replaceAll("|", "\\|").slice(0, 200)} |`);
  const count = (verdict: Verdict) => hunt.bugs.filter((b) => b.verdict === verdict).length;
  return [
    `Bug hunt over ${hunt.scope}: ${hunt.bugs.length} candidate${hunt.bugs.length > 1 ? "s" : ""}, ${count("confirmed")} confirmed, ${count("plausible")} plausible, ${count("not a bug")} not a bug${count("untriaged") ? `, ${count("untriaged")} untriaged` : ""}${hunt.triage?.by ? ` (checked by ${hunt.triage.by})` : ""}.${hunt.triage?.note ? ` ${hunt.triage.note}` : ""}`,
    "",
    "| Bug | Verdict | Severity | Where | What goes wrong | Advisor's reason |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Pick what to fix: /waicc-bug-pick all (confirmed and untriaged), /waicc-bug-pick all+plausible, or /waicc-bug-pick B1 B3.",
  ].join("\n");
}

/**
 * The bugs a selection names. `all` takes the confirmed ones and any nobody could check;
 * `all+plausible` adds the plausible ones; IDs take exactly those, even ones ruled not a bug.
 */
export function pickBugs(hunt: Hunt, selection: string): Bug[] {
  const words = selection.trim().split(/[\s,]+/).filter(Boolean);
  ensure(words.length, "Usage: /waicc-bug-pick all | all+plausible | <bug IDs, for example B1 B3>");
  ensure(hunt.bugs.length, "This bug hunt found no bugs, so there is nothing to pick");
  if (words.length === 1 && ["all", "all+plausible"].includes(words[0].toLowerCase())) {
    const verdicts: Verdict[] = words[0].toLowerCase() === "all" ? ["confirmed", "untriaged"] : ["confirmed", "untriaged", "plausible"];
    const picked = hunt.bugs.filter((b) => verdicts.includes(b.verdict));
    ensure(picked.length, `No bug is ${words[0].toLowerCase() === "all" ? "confirmed" : "confirmed or plausible"}. Name the ones you still want fixed, for example /waicc-bug-pick ${hunt.bugs[0].id}`);
    return picked;
  }
  const ids = words.map((word) => word.toUpperCase());
  const unknown = ids.filter((id) => !hunt.bugs.some((b) => b.id === id));
  ensure(!unknown.length, `No ${unknown.join(", ")} in this hunt; its bugs are ${hunt.bugs.map((b) => b.id).join(", ")}`);
  return hunt.bugs.filter((b) => ids.includes(b.id));
}

/** The picked bugs as a planning session's requirements. */
export function huntRequirements(hunt: Hunt, bugs: Bug[]): string {
  return `Fix these bugs, found by a bug hunt over ${hunt.scope}${hunt.triage?.by ? ` and checked by the advisor (${hunt.triage.by})` : ""}. For each one, first write a test or repro that fails because of it where that is practical, then fix it so the test passes, without changing unrelated behaviour.\n\n${bugs.map((b) =>
    `- ${b.id} (${b.severity}, ${b.verdict}) at ${b.file}:${b.line}. Trigger: ${b.trigger} What goes wrong: ${b.wrong}${b.reason ? ` Advisor: ${b.reason}` : ""}`).join("\n")}`;
}

export function markPicked(cwd: string, id: string, sessionId: string): Hunt {
  const root = projectRoot(cwd);
  return withLock(root, () => save(root, { ...loadHunt(root, id), status: "PICKED", sessionId }));
}
