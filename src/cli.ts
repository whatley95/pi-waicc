#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initialize, json, recoverLock, loadSession } from "./files.ts";
import { configureSvnIgnore } from "./ignore.ts";
import { deleteSession, restoreSession } from "./lifecycle.ts";
import { auditMemory, curate, propose, recall } from "./memory.ts";
import { initProject, projectRoot } from "./source.ts";
import { readErrors, recordError, sinceTime } from "./error-log.ts";
import { newFlow, readActivity, recordActivity, summarizeActivity } from "./activity-log.ts";
import { projectStatus, publish, recordTurn, trackedProjects, trackerEnabled } from "./tracker.ts";
import { checkpointView, refreshCheckpoint } from "./checkpoint.ts";
import {
  assess,
  beginDevelopment,
  decisionsView,
  resolveDecision,
  amend,
  cancel,
  closeSession,
  closeShipped,
  createSession,
  delegateWork,
  exportHandoff,
  forceCloseSession,
  ingest,
  issue,
  prepare,
  reopenSession,
  setRoundLimit,
  status,
  saveContext,
  useMainWork,
} from "./workflow.ts";
import { advisorInput, ensure } from "./validation.ts";
import { checkCommand } from "./checks.ts";
import { commandText, maxCheckMs, prepareDispatch, runAgent, runDispatch } from "./dispatch.ts";
import { elapsed } from "./progress.ts";
import { gitlabHost, initAgentConfig, profilesView, resolveDispatch } from "./profiles.ts";
import { planShip, requestOpener, ship } from "./ship.ts";
import { githubIssue, gitlabIssue, issueNote, issueNumber, issueRequirements } from "./issues.ts";
import { canonicalProject, gitlabClient, gitlabProject } from "./gitlab.ts";
import { chooseRemote } from "./revision.ts";
import { serveMcp } from "./mcp.ts";
import { finishBackgroundRun, startBackgroundDispatch } from "./background.ts";
import { selfTest, selfTestText } from "./selftest.ts";
import { ownerRules } from "./mcp-coordinator.ts";
import { huntRequirements, listHunts, markPicked, pickBugs, pickSplitAt, startHunt } from "./hunt.ts";
import type { Assessment, SessionListFilter } from "./workflow.ts";
import type { Mode, RoundPhase } from "./types.ts";
import type { ReviewRequest } from "./review.ts";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
let cwd = process.cwd();
if (rootIndex >= 0) {
  ensure(args[rootIndex + 1], "--root requires a directory");
  cwd = resolve(args[rootIndex + 1]);
  args.splice(rootIndex, 2);
}
const [command, id, ...rest] = args;
const file = (path: string) =>
  JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
function reviewInput(input: string[]): { review: ReviewRequest; focus: string } {
  ensure(
    input[0] === "--contract" || (input[0] === "--completion" && input[1]),
    "Review code changes with --completion <whole-work-report.json>, or explicitly use --contract for specification-only review",
  );
  return input[0] === "--contract"
    ? { review: { kind: "contract" }, focus: input.slice(1).join(" ") }
    : {
        review: { kind: "code", completion: file(input[1]) },
        focus: input.slice(2).join(" "),
      };
}
function flag(input: string[], name: string): string | undefined {
  const index = input.indexOf(name);
  if (index < 0) return undefined;
  ensure(input[index + 1], `${name} requires a value`);
  return input[index + 1];
}
// Each command is one line in the activity log, written when it ends; reading the logs is not.
const flow = newFlow(), startedAt = Date.now();
// The host chat that ran it, when one did: Claude Code's mod sets it, as Pi's chats are named in Pi's logs.
const chat = process.env.WAICC_CHAT ? { chat: process.env.WAICC_CHAT.slice(0, 80) } : {};
let outcome = "ok", known = true;
try {
  let output: unknown;
  switch (command) {
    case "mcp": {
      // stdout belongs to the protocol: nothing else may be written to it.
      const implement = args.includes("--implement");
      // The main agent's tools, for a host other than Pi (Claude Code's plugin starts it so).
      if (args[1] === "--coordinator") {
        ensure(args.length === 2 || (args.length === 3 && args[2] === "--rules-in-prompt"), "Usage: waicc mcp --coordinator [--rules-in-prompt]");
        await serveMcp(cwd, { coordinator: true, rulesInPrompt: args[2] === "--rules-in-prompt" });
        process.exit(0);
      }
      const options = args.slice(1).filter((word) => word !== "--implement");
      ensure(options.every((word, i) => i % 2 === 1 || ["--session", "--request", "--checks", "--check-cwd"].includes(word)), "Usage: waicc mcp --coordinator | mcp [--session <id> --request <id> [--implement] [--checks <file> [--check-cwd <dir>]]]");
      // --implement and --checks come from dispatch: an isolated worktree, and checks the human pre-approved.
      const pinnedRequest = Boolean(flag(options, "--session") && flag(options, "--request"));
      ensure(!implement || pinnedRequest, "--implement requires --session and --request");
      const checksFile = flag(options, "--checks");
      ensure(!checksFile || pinnedRequest, "--checks requires --session and --request");
      const checks = checksFile ? (file(checksFile) as unknown[]).map((check) => checkCommand(check, maxCheckMs)) : undefined;
      await serveMcp(cwd, { sessionId: flag(options, "--session"), requestId: flag(options, "--request"), implement, checks, checkCwd: flag(options, "--check-cwd") });
      process.exit(0);
    }
    case "dispatch": {
      ensure(id, "Usage: waicc dispatch <session> [profile] [--via claude|codex|pi|agy] [--model <model>] [--effort <level>] [--timeout <minutes>] [--implement] [--check '<command>']... [--confirm-checks] [--detach]");
      // --detach: the same dispatch in a process of its own (see background.ts); --background-run is that process.
      const detach = rest.includes("--detach"), background = rest.includes("--background-run");
      const options = rest.filter((word) => !["--detach", "--background-run"].includes(word));
      const resolved = resolveDispatch(cwd, id, options.filter((word) => word !== "--confirm-checks"));
      // A terminal has no dialog: checks from the repository's own file need this explicit flag.
      ensure(
        !resolved.confirmChecks || options.includes("--confirm-checks"),
        `These checks come from the project's agent config: ${resolved.options.checks?.map(commandText).join("; ")}. Review them, then add --confirm-checks to run them.`,
      );
      // The loop needs a main agent to assess and fix between reviews, which only Pi has.
      ensure(!resolved.options.loop, "--loop needs the main agent in Pi to assess and fix between reviews; use /waicc-dispatch --loop there.");
      if (detach) {
        // The options were checked above, so a mistake in them shows now; one in the handoff ends the run with its error.
        output = startBackgroundDispatch(cwd, id, options);
        break;
      }
      try {
        // Live steps go to stderr; stdout keeps the one JSON result.
        const outcome = await runDispatch(prepareDispatch(cwd, id, resolved.options), runAgent, undefined, (event) =>
          process.stderr.write(`[${elapsed(event.at)}] ${event.kind === "rejected" ? "✗ " : event.kind === "note" ? "says: " : ""}${event.text}\n`));
        // Without a main agent, continuing means validating the reply into AWAITING_ASSESSMENT.
        output = resolved.options.continue && outcome.replySubmitted ? { ...outcome, continued: ingest(cwd, id).status } : outcome;
        // Logged as Pi logs it: a run without a reply is what a review of the logs looks for.
        if (!outcome.replySubmitted)
          recordError(projectRoot(cwd), "waicc dispatch", `${resolved.options.via} finished without a reply${outcome.limit ? ` (${outcome.limit.text})` : ""}; see ${outcome.log}.`, { level: "warning", sessionId: id, flow, ...chat });
        if (background)
          finishBackgroundRun(cwd, id, outcome.replySubmitted
            ? { outcome: "reply", message: `${resolved.options.via} replied. /waicc-continue takes the reply in for the main agent to assess.` }
            : { outcome: "no-reply", message: `${resolved.options.via} ended without a reply${outcome.limit ? ` (${outcome.limit.text})` : ""}. Its log: ${outcome.log}` });
      } catch (error) {
        if (background) finishBackgroundRun(cwd, id, { outcome: "error", message: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      break;
    }
    case "turn": {
      // One main-agent turn from a host that reports usage per turn (Claude Code's mod): the activity
      // log's line, the chat's spend for the tracker page, and the page itself, refreshed.
      const turn = JSON.parse(id ?? "null") as { chatId?: string; model?: string; ms?: number; outcome?: string; sessionId?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | null;
      ensure(turn && typeof turn.chatId === "string" && turn.chatId.trim() && typeof turn.model === "string" && turn.model.trim(),
        'Usage: waicc turn \'{"chatId":"…","model":"…","ms":1200,"outcome":"answer","usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}\'');
      const root = projectRoot(cwd);
      const sessionId = typeof turn.sessionId === "string" && /^[0-9a-f-]{36}$/.test(turn.sessionId) ? { sessionId: turn.sessionId } : {};
      recordActivity(root, { flow, step: "main turn", phase: "end", outcome: String(turn.outcome ?? "answer"), ...(typeof turn.ms === "number" ? { ms: turn.ms } : {}), ...chat, ...sessionId,
        detail: { model: turn.model.slice(0, 120) } });
      const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
      const u = turn.usage ?? {};
      if (u && (n(u.input) || n(u.output) || n(u.cacheRead) || n(u.cacheWrite)))
        recordTurn(root, turn.chatId, turn.model, new Date(), { inputTokens: n(u.input) + n(u.cacheRead) + n(u.cacheWrite), cachedTokens: n(u.cacheRead), outputTokens: n(u.output) });
      if (trackerEnabled())
        try {
          publish(projectStatus(root));
        } catch { /* the page is a convenience */ }
      output = { recorded: true };
      break;
    }
    case "hunt": {
      // A bug hunt where the human has no Pi: start one, list them, or pick from the triaged one.
      const words = rest.join(" ").trim();
      if (id === "start") output = startHunt(cwd, words);
      else if (id === "pick") {
        const hunts = listHunts(cwd);
        const hunt = hunts.find((h) => h.status === "TRIAGED");
        ensure(hunt, hunts.some((h) => h.status === "SCANNING")
          ? "The bug hunt has not been reported yet: wait for the main agent's waicc_report_bugs and the advisor's check."
          : "No bug hunt is waiting to be picked from. Start one with /waicc-bug-hunt <scope>.");
        const bugs = pickBugs(hunt, words);
        const s = createSession(cwd, huntRequirements(hunt, bugs), undefined, "planning");
        markPicked(cwd, hunt.id, s.id);
        output = { ...s, picked: bugs.map((b) => b.id), ...(bugs.length > pickSplitAt ? { note: `${bugs.length} bugs make one contract large: a session allows at most 20 rounds.` } : {}) };
      } else {
        ensure(!id || id === "list", "Usage: waicc hunt start <scope> | hunt pick all|all+plausible|<bug IDs> | hunt list");
        output = listHunts(cwd).map((h) => ({ id: h.id, scope: h.scope, status: h.status, bugs: h.bugs.length, startedAt: h.startedAt, ...(h.sessionId ? { sessionId: h.sessionId } : {}) }));
      }
      break;
    }
    case "log": {
      // For a host that cannot append to WAICC's logs itself (Claude Code's mod): one entry, as JSON.
      const entry = JSON.parse(id ?? "null") as { kind?: string; step?: string; message?: string; level?: string; outcome?: string; ms?: number; sessionId?: string; detail?: Record<string, string | number | boolean | null> } | null;
      ensure(entry && typeof entry.step === "string" && entry.step.trim() && (entry.kind === "error" ? typeof entry.message === "string" : entry.kind === "activity"),
        'Usage: waicc log \'{"kind":"error","step":"/waicc-status","message":"…"}\' | \'{"kind":"activity","step":"main turn","outcome":"ok"}\'');
      const sessionId = typeof entry.sessionId === "string" && /^[0-9a-f-]{36}$/.test(entry.sessionId) ? { sessionId: entry.sessionId } : {};
      if (entry.kind === "error")
        recordError(projectRoot(cwd), entry.step!, entry.message!, { level: entry.level === "warning" ? "warning" : "error", flow, ...chat, ...sessionId });
      else
        recordActivity(projectRoot(cwd), {
          flow, step: entry.step!, phase: "end", outcome: String(entry.outcome ?? "ok"), ...(typeof entry.ms === "number" ? { ms: entry.ms } : {}),
          ...chat, ...sessionId, ...(entry.detail && typeof entry.detail === "object" ? { detail: entry.detail } : {}),
        });
      output = { logged: entry.kind };
      break;
    }
    case "init":
      output = initProject(cwd, initialize);
      break;
    case "profiles":
      ensure(!id || id === "init", "Usage: waicc profiles [init]");
      output = id === "init" ? initAgentConfig() : profilesView(cwd);
      break;
    case "start": {
      const words = args.slice(1);
      const delegated = words[0] === "--delegate";
      if (delegated) words.shift();
      if (words[0] !== "--issue") {
        output = createSession(cwd, words.join(" "), delegated ? "delegate" : undefined, "planning");
        break;
      }
      // --issue <n> [--remote r] [more requirements]: no dialog here, so the issue's text is printed with the session.
      const number = issueNumber(words[1] ?? "");
      const remoteAt = words[2] === "--remote" ? 3 : -1;
      const root = projectRoot(cwd);
      const { remote, url, provider } = chooseRemote(root, remoteAt > 0 ? words[remoteAt] : undefined);
      let fetched;
      if (provider === "github") fetched = await githubIssue(root, remote, number);
      else {
        const project = await canonicalProject(gitlabProject(url ?? ""));
        const host = gitlabHost(cwd, project.host);
        ensure(host?.token, `Reading issue #${number} from ${project.host} needs a GitLab token for it under "gitlab" in your user file`);
        fetched = await gitlabIssue(gitlabClient(project, host), remote, number);
      }
      const extra = words.slice(remoteAt > 0 ? 4 : 2).join(" ");
      output = { session: createSession(cwd, issueRequirements(fetched, extra), delegated ? "delegate" : undefined, "planning", fetched.link), note: issueNote(fetched.link) };
      break;
    }
    case "help-develop":
    case "implement":
    case "test": {
      const mode = command === "test" ? "testing" : "implementation";
      output = rest[0] === "--main"
        ? useMainWork(cwd, id, mode)
        : delegateWork(cwd, id, mode, rest.join(" ") ||
        (mode === "implementation" ? "Complete the entire accepted plan and all fixes; run relevant permitted checks" : "Verify the entire implementation and prior fixes with actual permitted checks; do not edit code/tests"));
      break;
    }
    case "develop":
      ensure(id && rest.length <= 1 && (!rest[0] || ["--main", "--delegate"].includes(rest[0])), "Usage: waicc develop <session-id> [--main|--delegate]");
      output = beginDevelopment(cwd, id, rest[0] === "--main" ? "main" : rest[0] === "--delegate" ? "delegate" : undefined);
      break;
    case "decisions":
      ensure(id && !rest.length, "Usage: waicc decisions <session-id>");
      output = decisionsView(cwd, id);
      break;
    case "decide":
      ensure(id && rest.length >= 2, "Usage: waicc decide <session-id> <decision-id> <answer>");
      output = resolveDecision(cwd, id, rest[0], rest.slice(1).join(" "));
      break;
    case "context":
      output = saveContext(cwd, id, rest.join(" "));
      break;
    case "compact":
      ensure(id && rest.length === 0, "Usage: waicc compact <session-id> (checkpoint only; Pi owns chat compaction)");
      output = refreshCheckpoint(cwd, id);
      break;
    case "checkpoint":
      ensure(id && rest.length === 0, "Usage: waicc checkpoint <session-id>");
      output = checkpointView(projectRoot(cwd), loadSession(projectRoot(cwd), id));
      break;
    case "status":
      output = ["open", "all", "closed", "deleted"].includes(id)
        ? status(cwd, undefined, id as SessionListFilter)
        : status(cwd, id);
      break;
    case "list":
      ensure(
        (!id || ["open", "all", "closed", "deleted"].includes(id)) &&
          rest.length === 0,
        "Usage: waicc list [open|all|closed|deleted]",
      );
      output = status(cwd, undefined, (id || "open") as SessionListFilter);
      break;
    case "delete":
      ensure(id && rest.length === 0, "Usage: waicc delete <session-id>");
      output = deleteSession(cwd, id);
      break;
    case "restore":
      ensure(id && rest.length === 0, "Usage: waicc restore <session-id>");
      output = restoreSession(cwd, id);
      break;
    case "prepare": {
      const s = loadSession(projectRoot(cwd), id);
      const mode = (rest[1] ?? "planning") as Mode;
      const review = mode === "review" ? reviewInput(rest.slice(2)) : undefined;
      output = prepare(
        cwd,
        id,
        file(rest[0]),
        mode,
        (review?.focus ?? rest.slice(2).join(" ")) ||
          "Inspect this contract against the original requirements and actual project.",
        s.contractVersion,
        review?.review,
      );
      break;
    }
    case "continue":
      output = ingest(cwd, id);
      break;
    case "assess":
      output = assess(cwd, id, file(rest[0]) as Assessment);
      break;
    case "request": {
      const review = rest[0] === "review" ? reviewInput(rest.slice(1)) : undefined;
      const focus = review
        ? review.focus || "Review all changes against requirements and actual evidence"
        : rest.slice(1).join(" ");
      output = issue(
        cwd, id, rest[0] as Mode,
        focus,
        undefined, undefined, review?.review,
      );
      break;
    }
    case "advisor": {
      const input = advisorInput(rest.join(" "));
      output = issue(
        cwd,
        id,
        "advisor",
        input.question,
        undefined,
        input.requirementIds,
      );
      break;
    }
    case "cancel":
      output = cancel(cwd, id, rest.join(" ") || undefined);
      break;
    case "close":
      output =
        rest[0] === "--force"
          ? forceCloseSession(cwd, id, rest.slice(1).join(" ") || undefined)
          : closeSession(cwd, id, rest.join(" "));
      break;
    case "ship": {
      // No dialog here: --yes is your confirmation, after reading what --dry-run shows.
      const dry = rest.includes("--dry-run"), yes = rest.includes("--yes");
      const words = rest.filter((word) => word !== "--dry-run" && word !== "--yes");
      ensure(id && (dry || yes), "Usage: waicc ship <session> [--into <branch>] [--branch <name>] [--remote <remote>] [--draft] --dry-run|--yes");
      const plan = planShip(cwd, id, {
        into: flag(words, "--into"), branch: flag(words, "--branch"), remote: flag(words, "--remote"), draft: words.includes("--draft"),
      });
      if (dry) {
        output = { dryRun: true, ...plan, message: undefined };
        break;
      }
      const shipped = await ship(plan, await requestOpener(plan, { host: (name) => gitlabHost(cwd, name) }));
      closeShipped(cwd, id, shipped);
      output = { shipped };
      break;
    }
    case "reopen":
      output = reopenSession(cwd, id, rest.join(" "));
      break;
    case "amend":
      output = amend(cwd, id, rest.join(" "));
      break;
    case "export":
      output = {
        exportPath: exportHandoff(cwd, id),
        includesSourceCode: false,
        whatToSend:
          "Provide the ENTIRE export folder and paste its STARTER.txt CONTENTS; the recipient also needs matching project source. Return reply.json to manifest.returnReplyTo, then continue in the coordinator.",
      };
      break;
    case "limit":
      ensure(rest.length === 1 || rest.length === 2, "Usage: waicc limit <session> [phase] <2-20>");
      output = setRoundLimit(cwd, id, Number(rest.at(-1)), rest.length === 2 ? rest[0] as RoundPhase : undefined);
      break;
    case "ignore":
      output = configureSvnIgnore(projectRoot(cwd));
      break;
    case "memory":
      output = ["confirm", "revoke"].includes(id)
        ? curate(cwd, rest[0], id as "confirm" | "revoke")
        : id === "audit" && rest.length === 0
          ? auditMemory(cwd)
          : recall(cwd, args.slice(1).join(" "), true);
      break;
    case "learn":
      output = propose(cwd, rest.join(" "), id);
      break;
    case "errors": {
      // This project's error log, or with --all every project on the tracker: oldest first.
      const input = args.slice(1);
      const since = flag(input, "--since");
      const all = input.includes("--all");
      ensure(input.every((word, i) => word === "--all" || word === "--since" || input[i - 1] === "--since"), "Usage: waicc errors [--since <ISO time or 30m|6h|2d>] [--all]");
      const from = since === undefined ? "" : sinceTime(since);
      const projects = all ? trackedProjects().map((p) => ({ name: p.name, root: p.root })) : [{ name: null, root: projectRoot(cwd) }];
      const rows = projects.map((p) => ({ ...p, errors: readErrors(p.root).filter((e) => e.at > from) })).filter((p) => !all || p.errors.length);
      output = {
        since: from || null,
        ...(all ? { note: "Projects on the tracker (updated by Pi in the last 14 days; the tracker must be on)." } : {}),
        count: rows.reduce((n, p) => n + p.errors.length, 0),
        projects: rows,
      };
      break;
    }
    case "activity": {
      // This project's activity log, oldest first: all of it, one flow with its errors, or each step's totals.
      const input = args.slice(1);
      const since = flag(input, "--since"), only = flag(input, "--flow");
      const summary = input.includes("--summary");
      ensure(input.every((word, i) => ["--summary", "--since", "--flow"].includes(word) || ["--since", "--flow"].includes(input[i - 1])), "Usage: waicc activity [--since <ISO time or 30m|6h|2d>] [--flow <id>] [--summary]");
      const from = since === undefined ? "" : sinceTime(since);
      const root = projectRoot(cwd);
      const entries = readActivity(root).filter((e) => e.at > from && (!only || e.flow === only));
      output = summary
        ? { since: from || null, steps: summarizeActivity(entries) }
        : { since: from || null, count: entries.length, entries, ...(only ? { errors: readErrors(root).filter((e) => e.flow === only) } : {}) };
      break;
    }
    case "recover-lock":
      recoverLock(projectRoot(cwd));
      output = { recovered: true };
      break;
    case "rules":
      // The owner's rules, for Claude Code's mod to put in the system prompt.
      output = { text: ownerRules(cwd) };
      break;
    case "selftest": {
      // Any failed check fails the command, with every check's line as its error.
      ensure(!id || id === "--no-model", "Usage: waicc selftest [--no-model]");
      const report = await selfTest(cwd, { models: id !== "--no-model" });
      if (!report.ok) throw new Error(selfTestText(report));
      output = { ...report, text: selfTestText(report) };
      break;
    }
    default:
      // Not a command: not logged either, since the word typed could be anything.
      known = false;
      if (command && command !== "help" && command !== "--help")
        process.exitCode = 2;
      output = {
        usage:
          "waicc [--root project] start [--delegate] <requirements> | start [--delegate] --issue <number> [--remote <remote>] [more requirements] | dispatch <session> [profile] [--via claude|codex|pi|agy] [--confirm-checks] [--model <model>] [--timeout <minutes>] [--implement] [--check '<command>']... [--check-timeout <minutes>] | init | profiles [init] | mcp --coordinator [--rules-in-prompt] | mcp [--session <id> --request <id>] | develop <session> [--main|--delegate] | decisions <session> | decide <session> <decision-id> <answer> | help-develop <session> [--main] [focus] | implement <session> [--main] [focus] (alias of help-develop) | test <session> [--main] [focus] | context <session> <summary> | compact <session> | checkpoint <session> | status [session|open|all|closed|deleted] | list [open|all|closed|deleted] | delete <session> | restore <session> | prepare <session> <contract.json> [planning|review] [--completion report.json|--contract for review] [focus] | continue <session> | assess <session> <assessment.json> | request <session> planning|review|advisor|implementation|testing [--completion report.json|--contract for review] <focus> | advisor <session> [--requirements REQ-001,REQ-002] <question> | close <session> <reason> | ship <session> [--into <branch>] [--branch <name>] [--remote <remote>] [--draft] --dry-run|--yes | close <session> --force [reason] | reopen <session> <reason> | cancel <session> [reason] | amend <session> <requirements> | export <session> | limit <session> [phase] <2-20> | memory [confirm|revoke <id>|audit] | learn <source-path> <lesson> | errors [--since <ISO time or 30m|6h|2d>] [--all] | activity [--since <ISO time or 30m|6h|2d>] [--flow <id>] [--summary] | selftest [--no-model] | recover-lock",
      };
  }
  process.stdout.write(json(output));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  outcome = "error";
  try {
    recordError(projectRoot(cwd), `waicc ${command ?? ""}`.trim(), message, { flow, ...chat });
  } catch { /* no project here: nothing to log into */ }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
// Reading the settings (the Claude Code mod checks autoContinue every 30 s) is not activity either.
const readsProfiles = command === "profiles" && args.length === 1;
if (command && known && !readsProfiles && !["activity", "errors", "mcp", "log", "turn", "rules"].includes(command))
  try {
    // Which options were used and which session, never what was typed with them.
    const flags = [...new Set(args.filter((word) => /^--[a-z][a-z-]*$/.test(word)))].join(" ");
    recordActivity(projectRoot(cwd), {
      flow, step: `waicc ${command}`.slice(0, 40), phase: "end", ms: Date.now() - startedAt, outcome, ...chat,
      ...(id && /^[a-f0-9-]{36}$/.test(id) ? { sessionId: id } : {}), ...(flags ? { detail: { flags } } : {}),
    });
  } catch { /* no project here: nothing to log into */ }
