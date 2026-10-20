import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifact, atomicWrite, digest, json, loadSession, runtimePath, safePath, sessionRelative } from "./files.ts";
import { dispatchPinVariable } from "./dispatch.ts";
import { roundDirectory, versionDirectory } from "./render.ts";
import { sessionPhase } from "./state.ts";
import type { Contract, ContractVersion, RevisionReview, Round, Session } from "./types.ts";
import { gitlabProject, reviewComments } from "./gitlab.ts";
import { repositoryPrefix } from "./revision.ts";
import type { PostedComments } from "./workflow.ts";
import { chatUsage, totalUsage, type ChatHour, type Usage } from "./usage.ts";
import { pendingLessons } from "./memory.ts";

/**
 * One page for every project: each Pi chat writes its project's status file, then rebuilds the
 * page's data from all of them. Nothing here may slow or stop WAICC: callers ignore failures.
 */

/** An agent at work right now, from the chat that started it. */
export interface LiveRun {
  kind: "dispatch" | "advisor" | "main";
  sessionId: string | null;
  label: string;
  startedAt: number;
  steps: { at: number; kind: string; text: string }[];
  said: string | null;
  /** When the agent last showed a step, and how long without one counts as quiet (0: never). */
  lastActivityAt?: number;
  quietAfterMs?: number;
}
/** Minutes a running agent has shown nothing new, once that passes its quiet limit; else null. */
export function quietMinutes(run: LiveRun, now = Date.now()): number | null {
  if (!run.quietAfterMs || run.lastActivityAt === undefined) return null;
  const quiet = now - run.lastActivityAt;
  return quiet >= run.quietAfterMs ? Math.floor(quiet / 60_000) : null;
}
export interface Notice { at: string; level: "info" | "warning" | "error"; text: string }

const clip = (value: unknown, max = 400): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Pi's agent directory, where your profiles live; honours PI_CODING_AGENT_DIR. */
export const trackerDirectory = (): string =>
  join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "waicc-tracker");
export const trackerPage = (): string => join(trackerDirectory(), "index.html");
const offMarker = () => join(trackerDirectory(), "off");
const templatePath = (): string => fileURLToPath(new URL("../templates/tracker.html", import.meta.url));

/** On unless you turned it off; never in dispatched agents or in this package's own tests. */
export function trackerEnabled(): boolean {
  return process.env.WAICC_TRACKER !== "off" && !process.env[dispatchPinVariable] && !existsSync(offMarker());
}
export function setTrackerEnabled(on: boolean): void {
  if (on) rmSync(offMarker(), { force: true });
  else atomicWrite(offMarker(), "The WAICC tracker is off. /waicc-tracker on turns it back on.\n");
}

interface DispatchRecord { via: string; model: string | null; effort: string | null; durationMs: number; replySubmitted: boolean; finishedAt: string; usage?: Usage | null }
/** Every finished dispatch of a round, oldest first: failed runs cost money too. */
function dispatchRuns(root: string, s: Session, r: Round) {
  return Object.keys(s.artifacts).filter((p) => p.startsWith(`${roundDirectory(r)}/dispatch/`) && p.endsWith("/result.json")).flatMap((path) => {
    try {
      const d = JSON.parse(artifact(root, s, path)) as DispatchRecord;
      return [{ via: d.via, model: d.model, effort: d.effort, durationMs: d.durationMs, replySubmitted: d.replySubmitted, finishedAt: d.finishedAt, usage: d.usage ?? null }];
    } catch {
      return [];
    }
  }).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
}

/** One agent run with what it used, for the page's spend figures; for the main agent, one model's hour in one chat. */
export interface SpendRun {
  at: string; kind: "dispatch" | "advisor" | "main"; mode: string; via: string; model: string | null; sessionId: string | null; usage: Usage;
  chatId?: string; messages?: number;
}

const projectKey = (root: string): string => digest(process.platform === "win32" ? root.toLowerCase() : root).slice(0, 16);
const chatFolder = (root: string): string => join(trackerDirectory(), "chats", projectKey(root));
/** The main agent of one Pi chat in a project: its model now, and what it has used. */
export interface ChatRecord { schemaVersion: 1; chatId: string; name: string | null; model: string | null; updatedAt: string; hours: ChatHour[] }

/** Saves what this chat's main agent has used, so every chat in the project is counted, whichever writes the page. */
export function recordChat(root: string, chatId: string, name: string | null, model: string | null, entries: readonly unknown[]): void {
  const record: ChatRecord = { schemaVersion: 1, chatId, name: clip(name, 120), model, updatedAt: new Date().toISOString(), hours: chatUsage(entries) };
  atomicWrite(join(chatFolder(root), `${chatId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`), json(record));
}
const chatCache = new Map<string, { mtimeMs: number; record: ChatRecord | null }>();
function chats(root: string): ChatRecord[] {
  const folder = chatFolder(root);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith(".json")).flatMap((name) => {
    const path = join(folder, name);
    try {
      const mtimeMs = statSync(path).mtimeMs;
      let cached = chatCache.get(path);
      if (cached?.mtimeMs !== mtimeMs) {
        const record = JSON.parse(readFileSync(path, "utf8")) as ChatRecord;
        cached = { mtimeMs, record: record.schemaVersion === 1 && Array.isArray(record.hours) ? record : null };
        chatCache.set(path, cached);
      }
      return cached.record ? [cached.record] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
}

/** The merge request's web page, from the remote it was fetched from; null when that cannot be told. */
export function mergeRequestUrl(m: NonNullable<RevisionReview["mergeRequest"]>): string | null {
  if (!m.url) return null;
  if (m.provider === "github") {
    const repo = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(m.url)?.[1];
    return repo ? `https://github.com/${repo}/pull/${m.number}` : null;
  }
  try {
    const project = gitlabProject(m.url);
    return `${project.origin}/${project.path}/-/merge_requests/${m.number}`;
  } catch {
    return null;
  }
}

/** A review of an existing change: what it covers, what was posted to its merge request, and what is left to post. */
function changeView(root: string, s: Session) {
  const rev = s.revisionReview;
  if (!rev) return null;
  const m = rev.mergeRequest;
  const posts = Object.keys(s.artifacts).filter((path) => /^mr-comments\/[^/]+\.json$/.test(path)).sort().flatMap((path) => {
    try {
      return [JSON.parse(artifact(root, s, path)) as PostedComments];
    } catch {
      return [];
    }
  });
  const round = s.rounds.findLast((r) => r.review?.kind === "code" && r.status === "ASSESSED" && r.reply);
  let toPost: number | null = null;
  if (m?.provider === "gitlab" && round && s.status !== "CLOSED")
    try {
      const done = new Set(posts.flatMap((p) => p.comments.map((c) => c.key)));
      toPost = reviewComments(s, round, repositoryPrefix(root), null).filter((c) => !done.has(c.key)).length;
    } catch { /* counted as unknown */ }
  return {
    label: rev.label, range: rev.range, vcs: rev.vcs, from: rev.from.slice(0, 10), to: rev.to.slice(0, 10),
    mergeRequest: m ? { number: m.number, provider: m.provider, target: m.target, webUrl: mergeRequestUrl(m) } : null,
    posted: posts.length ? {
      lineComments: posts.reduce((n, p) => n + p.comments.filter((c) => c.inline).length, 0),
      summaries: posts.filter((p) => p.summaryNoteId !== null).length,
      lastAt: posts.at(-1)!.postedAt,
    } : null,
    // An assessed review of a GitLab merge request that has not been posted yet.
    awaitingPost: Boolean(m?.provider === "gitlab" && round && s.status !== "CLOSED" && !posts.some((p) => p.requestId === round.id)),
    toPost,
  };
}

function sessionView(root: string, s: Session) {
  let c: Contract | null = null;
  if (s.contractVersion > 0)
    try {
      c = (JSON.parse(artifact(root, s, `${versionDirectory(s.contractVersion)}/contract.json`)) as ContractVersion).contract;
    } catch { /* shown without its contract */ }
  // The latest whole-work report: a claim the tracker shows as such, never as verified delivery.
  const report = s.rounds.findLast((r) => r.reply?.completion || r.review?.kind === "code");
  const completion = report?.reply?.completion ?? (report?.review?.kind === "code" ? report.review.completion : undefined);
  const reported = new Set(completion?.tasks.map((t) => t.taskId) ?? []);
  const runs: SpendRun[] = [];
  const rounds = s.rounds.map((r, i) => {
    const dispatches = dispatchRuns(root, s, r);
    for (const d of dispatches)
      if (d.usage) runs.push({ at: d.finishedAt, kind: "dispatch", mode: r.review?.kind === "code" ? "code review" : r.mode, via: d.via, model: d.model, sessionId: s.id, usage: d.usage });
    return {
      n: i + 1, id: r.id, mode: r.mode, kind: r.review?.kind ?? null, status: r.status,
      outcome: r.reply?.outcome ?? null, decision: r.decision ?? null,
      summary: clip(r.reply?.summary), rationale: clip(r.rationale, 300), question: clip(r.advisor?.question, 300),
      findings: (r.reply?.findings ?? []).slice(0, 10).map((f) => ({ severity: f.severity, description: clip(f.description, 240) })),
      findingCount: r.reply?.findings.length ?? 0,
      checks: (r.reply?.checks ?? []).slice(0, 20).map((check) => ({ description: clip(check.description, 200), outcome: check.outcome })),
      dispatch: dispatches.at(-1) ?? null,
      // Which commit a review of an existing change saw.
      reviewedAt: r.review?.kind === "code" && r.review.revision ? r.review.revision.to.slice(0, 10) : null,
      attempts: dispatches.length,
      usage: dispatches.some((d) => d.usage) ? totalUsage(dispatches.map((d) => d.usage)) : null,
    };
  });
  return {
    id: s.id,
    title: clip(c?.title, 160) ?? clip(s.requirements[0]?.split("\n")[0], 160) ?? "Untitled",
    status: s.status,
    phase: sessionPhase(s),
    objective: s.objective ?? null,
    contractVersion: s.contractVersion,
    implementationOwner: s.implementationOwner ?? "main",
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    requirements: c?.requirements.map((req) => ({ id: req.id, text: clip(req.text, 300) })) ?? [],
    tasks: c?.tasks.map((t) => ({ id: t.id, title: clip(t.title, 200), reported: reported.has(t.id) })) ?? [],
    decisions: (c?.decisions ?? []).map((d) => ({
      id: d.id, question: clip(d.question, 300), owner: d.owner, status: d.status,
      recommendation: clip(d.recommendation, 300), answer: clip(d.answer, 300), risk: d.risk ?? null,
    })),
    rounds,
    spend: totalUsage(runs.map((run) => run.usage)),
    runs,
    change: changeView(root, s),
    closedAt: s.closure?.closedAt ?? null,
  };
}
export type SessionView = ReturnType<typeof sessionView>;

// Sessions are summarised again only when their journal moves on.
const views = new Map<string, { stamp: string; view: SessionView }>();
function sessions(root: string): SessionView[] {
  const folder = safePath(root, `${runtimePath}/sessions`);
  if (!existsSync(folder)) return [];
  const found: SessionView[] = [];
  for (const id of readdirSync(folder).filter((name) => /^[a-f0-9-]{36}$/.test(name))) {
    try {
      const journal = safePath(root, `${sessionRelative(id)}/journal`);
      const stamp = readdirSync(journal).filter((name) => /^\d{8}-[a-f0-9-]+\.json$/.test(name)).sort().at(-1);
      if (!stamp) continue;
      const cacheKey = `${root}\0${id}`;
      let cached = views.get(cacheKey);
      if (cached?.stamp !== stamp) {
        cached = { stamp, view: sessionView(root, loadSession(root, id)) };
        views.set(cacheKey, cached);
      }
      found.push(cached.view);
    } catch { /* an unreadable session is left out, not fatal */ }
  }
  return found;
}

/** What one session's dispatches have cost so far, as the agents reported it. */
export function sessionSpend(root: string, id: string): Usage & { runs: number; unpricedRuns: number } {
  const s = loadSession(root, id);
  return totalUsage(s.rounds.flatMap((r) => dispatchRuns(root, s, r).map((d) => d.usage)));
}

function readConsult(folder: string, id: string) {
  try {
    const result = JSON.parse(readFileSync(join(folder, id, "result.json"), "utf8")) as { via: string; model: string | null; finishedAt: string; durationMs: number; answer: string | null; usage?: Usage | null };
    const brief = readFileSync(join(folder, id, "brief.md"), "utf8");
    return { id, question: clip(/## Question\n\n([\s\S]*?)\n\n(?:## |$)/.exec(brief)?.[1], 400), via: result.via, model: result.model,
      finishedAt: result.finishedAt, durationMs: result.durationMs, answer: clip(result.answer, 4_000), usage: result.usage ?? null };
  } catch {
    return null;
  }
}
// A finished consult never changes, so each is read once.
const consultCache = new Map<string, ReturnType<typeof readConsult>>();
function consults(root: string) {
  const folder = safePath(root, `${runtimePath}/consults`);
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((id) => {
    const cacheKey = join(folder, id);
    if (!consultCache.has(cacheKey) && existsSync(join(folder, id, "result.json"))) consultCache.set(cacheKey, readConsult(folder, id));
    const consult = consultCache.get(cacheKey);
    return consult ? [consult] : [];
  }).sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
}

/** What needs the human, in this project: their decisions, and each session's next human step. */
function needsYou(views: SessionView[], live: LiveRun[]) {
  const busy = new Set(live.map((run) => run.sessionId));
  // The text never carries the minutes, so one quiet spell is one item.
  const quiet = live.filter((run) => quietMinutes(run) !== null).map((run) => ({
    sessionId: run.sessionId, text: `${run.label.replace(/^WAICC · /, "")}: no new step for ${Math.round(run.quietAfterMs! / 60_000)}+ minutes`,
    detail: run.steps.at(-1) ? `Last step: ${run.steps.at(-1)!.text}. It may still be working.` : "It has shown no step yet.",
    command: run.kind === "advisor" ? "Esc stops the advisor" : "/waicc-dispatch --stop",
  }));
  return [...quiet, ...views.filter((s) => s.status !== "CLOSED").flatMap((s) => {
    const items = s.decisions.filter((d) => d.status === "open" && d.owner !== "agent").map((d) => ({
      sessionId: s.id, text: `${d.id}: ${d.question}`, detail: d.recommendation ? `Recommended: ${d.recommendation}` : null,
      command: d.owner === "external" ? `/waicc-decide ${d.id} <answer from its owner>` : d.recommendation ? `/waicc-decide ${d.id} recommended` : `/waicc-decide ${d.id} <answer>`,
    }));
    if (busy.has(s.id)) return items;
    const step: Record<string, [string, string]> = {
      READY_TO_CLOSE: ["Review passed: ready for you to close", "/waicc-close <reason>"],
      PLAN_READY: ["Plan accepted: start development when ready", "/waicc-develop"],
      AWAITING_ASSESSMENT: ["A reply is waiting to be assessed", "/waicc-continue"],
      NEEDS_CLARIFICATION: ["Needs clarification from you", "/waicc-status"],
      BLOCKED: ["Blocked: see the latest assessment", "/waicc-status"],
      WAITING_FOR_REPLY: ["A handoff is waiting for an agent", "/waicc-dispatch"],
    };
    const next = step[s.status];
    // An assessed merge request review comes first: posting it is what the author is waiting for.
    const mr = s.change?.awaitingPost ? s.change.mergeRequest : null;
    const post = mr ? [{
      sessionId: s.id,
      text: `Review of merge request !${mr.number} is ready to post to GitLab${s.change!.toPost === null ? "" : s.change!.toPost ? `: ${s.change!.toPost} finding${s.change!.toPost === 1 ? "" : "s"}` : ": no issues found"}`,
      detail: s.title, command: "/waicc-mr-comments",
    }] : [];
    return [...items, ...post, ...(next ? [{ sessionId: s.id, text: next[0], detail: s.title, command: next[1] }] : [])];
  })];
}

/**
 * What needs you now that did not at the last look, for desktop notifications. The last look is
 * kept beside the page, so a second chat in the project or a restart does not repeat one; the
 * very first look only remembers. An item that goes away and comes back is new again.
 */
export function newNeeds(status: ProjectStatus): ProjectStatus["needsYou"] {
  const path = join(trackerDirectory(), "alerted", `${status.key}.json`);
  const id = (n: ProjectStatus["needsYou"][number]) => `${n.sessionId ?? ""}\0${n.text}`;
  let seen: Set<string> | null = null;
  try {
    seen = new Set((JSON.parse(readFileSync(path, "utf8")) as { seen: string[] }).seen);
  } catch { /* first look */ }
  const now = status.needsYou.map(id);
  if (seen && now.length === seen.size && now.every((key) => seen!.has(key))) return [];
  atomicWrite(path, json({ seen: now }));
  return seen ? status.needsYou.filter((n) => !seen!.has(id(n))) : [];
}

export function projectStatus(root: string, live: LiveRun[] = [], notices: Notice[] = [], selectedSessionId: string | null = null, budgetUsd: number | null = null,
  extension: { version: string | null; build: string; outdated: boolean } | null = null) {
  const all = sessions(root);
  // Open sessions first, newest first; only the five most recent closed ones are shown in full.
  const newest = (a: SessionView, b: SessionView) => b.updatedAt.localeCompare(a.updatedAt);
  const shown = [...all.filter((s) => s.status !== "CLOSED").sort(newest), ...all.filter((s) => s.status === "CLOSED").sort(newest).slice(0, 5)];
  const asked = consults(root);
  const talked = chats(root);
  // Every run's figures, closed sessions included, so the page can total any period itself.
  const everyRun: SpendRun[] = [
    ...all.flatMap((s) => s.runs),
    ...asked.flatMap((c) => (c.usage ? [{ at: c.finishedAt, kind: "advisor" as const, mode: "advisor", via: c.via, model: c.model, sessionId: null, usage: c.usage }] : [])),
    ...talked.flatMap((c) => c.hours.map((h) => ({ at: h.at, kind: "main" as const, mode: "main agent", via: "main agent", model: h.model, sessionId: null, usage: h.usage, chatId: c.chatId, messages: h.messages }))),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const runs = everyRun.slice(0, 2_000);
  // Exact totals over everything recorded, before the list above is cut, by who used it.
  const allTime = {
    since: everyRun.at(-1)?.at ?? null,
    byKind: Object.fromEntries((["main", "dispatch", "advisor"] as const).map((kind) => {
      const mine = everyRun.filter((run) => run.kind === kind);
      return [kind, { ...totalUsage(mine.map((run) => run.usage)), messages: mine.reduce((n, run) => n + (run.messages ?? 0), 0) }];
    })) as Record<SpendRun["kind"], ReturnType<typeof totalUsage> & { messages: number }>,
  };
  return {
    schemaVersion: 1 as const,
    key: projectKey(root),
    name: basename(root) || root,
    root,
    updatedAt: new Date().toISOString(),
    pid: process.pid,
    selectedSessionId,
    budgetUsd,
    extension,
    live,
    notices: notices.slice(-5),
    sessions: shown.map(({ runs: _runs, ...view }) => view),
    consults: asked.slice(0, 10),
    chats: talked.slice(0, 10).map(({ chatId, name, model, updatedAt }) => ({ chatId, name, model, updatedAt })),
    runs,
    allTime,
    needsYou: [
      ...(extension?.outdated
        ? [{ sessionId: null, text: "pi-waicc was updated: a Pi chat here still runs the copy it loaded", detail: "Type /reload in that chat to load the new version", command: "/reload" }]
        : []),
      ...needsYou(shown, live),
      ...pendingLessons(root).map((lesson) => ({ sessionId: null, text: `Lesson to confirm: ${clip(lesson.text, 200)}`, detail: lesson.source, command: "/waicc-memory confirm" })),
    ],
  };
}
export type ProjectStatus = ReturnType<typeof projectStatus>;

let pageWritten = "";
/** Saves this project's status, then the page's data for every project; returns the page. */
export function publish(status: ProjectStatus): string {
  const dir = trackerDirectory();
  atomicWrite(join(dir, "projects", `${status.key}.json`), json(status));
  const cutoff = Date.now() - 14 * 24 * 3_600_000;
  const projects = readdirSync(join(dir, "projects")).filter((name) => /^[a-f0-9]{16}\.json$/.test(name)).flatMap((name) => {
    const path = join(dir, "projects", name);
    try {
      if (statSync(path).mtimeMs < cutoff) return [];
      const project = JSON.parse(readFileSync(path, "utf8")) as ProjectStatus;
      return project.schemaVersion === 1 && existsSync(project.root) ? [project] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
  // A script, not JSON: a page opened from disk may load scripts beside it but not fetch files.
  atomicWrite(join(dir, "data.js"), `window.waiccTracker(${JSON.stringify({ generatedAt: new Date().toISOString(), projects })});\n`);
  const page = trackerPage();
  if (!pageWritten || !existsSync(page)) {
    pageWritten = readFileSync(templatePath(), "utf8");
    if (!existsSync(page) || readFileSync(page, "utf8") !== pageWritten) writeFileSync(page, pageWritten);
  }
  return page;
}

/** Opens the page in the default browser, without waiting; false if that could not start. */
export function openPage(path: string): boolean {
  const [program, args] = process.platform === "win32" ? ["explorer.exe", [path]]
    : process.platform === "darwin" ? ["open", [path]] : ["xdg-open", [path]];
  try {
    const child = spawn(program, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => { /* no browser: the path is shown instead */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
