import { recipientAssignment } from "../recipient.ts";
import type { GitLabCall, GitLabHost, GitLabProject, OriginProbe } from "../gitlab.ts";
import type { ShipPlan } from "../ship.ts";
import type { FetchedIssue } from "../issues.ts";
import type { Shipped } from "../types.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { json, loadSession } from "../files.ts";
import { copyHandoffPrompt, type ClipboardWriter, type ClipboardResult } from "../clipboard.ts";
import type { CheckRunner } from "../checks.ts";
import type { AgentRunner } from "../dispatch.ts";
import { alertSettings, decisionSettings, sessionBudget, policyGuidance } from "../profiles.ts";
import { buildOutdated, loadedBuild } from "../build.ts";
import { newNeeds, projectStatus, publish, recordChat, trackerEnabled, type LiveRun, type Notice, type ProjectStatus } from "../tracker.ts";
import { notifyDesktop } from "../alerts.ts";
import { autoDecidable } from "../decisions.ts";
import { elapsed, type ProgressEvent } from "../progress.ts";
import { checkpointView } from "../checkpoint.ts";
import { recall } from "../memory.ts";
import { projectRoot, samePath, snapshot } from "../source.ts";
import type { manualHandoff } from "../render.ts";
import { resolveDecision, readContract, requirementsText, status } from "../workflow.ts";
import { decodeJsonArguments, ensure } from "../validation.ts";
import type { ContractDecision } from "../types.ts";
import { AutoPlanningRequests } from "../auto-planning.ts";
import { type ChatBinding, compactionInstructions, recipientReads, guidance } from "./shared.ts";
import type { Runs } from "./runs.ts";

export interface Services {
  copyText?: ClipboardWriter; runCheck?: CheckRunner; runAgent?: AgentRunner; openPage?: (path: string) => boolean;
  notifyDesktop?: (title: string, body: string) => boolean;
  /** GitLab's API client, replaceable in tests. */
  gitlab?: (project: GitLabProject, host: GitLabHost) => GitLabCall;
  /** Finds where a GitLab server really answers (redirects followed, no token), replaceable in tests. */
  gitlabOrigin?: OriginProbe;
  /** Opens a new terminal in a folder running Pi, replaceable in tests. */
  openTerminal?: (path: string) => boolean;
  /** Reads a GitHub issue for /waicc-planning --issue (gh), replaceable in tests. */
  githubIssue?: (root: string, remote: string, number: number) => Promise<FetchedIssue>;
  /** Opens a GitHub pull request for /waicc-ship (gh), replaceable in tests. */
  github?: (plan: ShipPlan) => Promise<Shipped["request"]>;
  /** Saves a Windows user environment variable (what setx does), replaceable in tests. */
  saveUserVariable?: (name: string, value: string) => boolean;
}

/**
 * The extension's shared state and helpers: chat bindings, running dispatches, the tracker,
 * and the command and tool wrappers. Commands, tools and hooks receive this one object.
 */
export function createApp(pi: ExtensionAPI, services: Services = {}) {
  const bindings = new Map<string, ChatBinding>();
  const copied = new Map<string, string>();
  /** Every /waicc-* command by name, as typed: waicc_suggest_command runs the one the human picks. */
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<string | null>>();
  const compactedRuns = new Set<string>();
  const automaticRequests = new AutoPlanningRequests();
  // Every WAICC tool accepts nested arguments sent as JSON text (see decodeJsonArguments).
  // The tracker page is refreshed after every tool and command (see track).
  const registerTool: ExtensionAPI["registerTool"] = (tool) =>
    pi.registerTool({ ...tool, execute: async (id, params, signal, update, ctx) => {
      try {
        return await tool.execute(id, decodeJsonArguments(params, tool.parameters), signal, update, ctx);
      } finally {
        track(ctx);
      }
    } });
  const dispatches = new Map<string, {
    controller: AbortController; done: Promise<unknown>;
    label: string; startedAt: number; events: ProgressEvent[]; root: string; lastActivityAt: number; quietAfterMs: number;
  }>();
  /** The main agent's advisor questions in progress, by chat. */
  const advising = new Map<string, LiveRun & { root: string }>();
  /** The main agent's turn in progress, by chat: what it is doing, for the tracker. */
  const mainTurns = new Map<string, { root: string; label: string; startedAt: number; events: ProgressEvent[]; read: (line: string) => ProgressEvent[]; ticker: ReturnType<typeof setInterval> }>();
  /** Recent run outcomes per project, for the tracker page. */
  const notices = new Map<string, Notice[]>();
  const trackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One notification per new needs-you item, or one for several; only with "alerts.desktop" on. */
  function alertDesktop(status: ProjectStatus): void {
    const fresh = newNeeds(status);
    if (!fresh.length) return;
    if (fresh.length === 1) (services.notifyDesktop ?? notifyDesktop)(`WAICC · ${status.name}`, `${fresh[0].text} · ${fresh[0].command}`);
    else (services.notifyDesktop ?? notifyDesktop)(`WAICC · ${status.name}: ${fresh.length} things need you`, fresh.slice(0, 3).map((n) => n.text).join(" · "));
  }
  // Said once per loaded copy: after pi update, an open chat keeps the code it started with.
  let outdatedWarned = false;
  function warnOutdated(ctx: ExtensionContext): void {
    try {
      if (outdatedWarned || !ctx.hasUI || bindings.get(key(ctx))?.role === "recipient" || !buildOutdated()) return;
      outdatedWarned = true;
      ctx.ui.notify("pi-waicc was updated since this chat loaded it. Type /reload to use the new version.", "warning");
    } catch { /* a notice only */ }
  }
  // Per chat: the entry count and model last saved, so an unchanged chat is not summarised again.
  const chatsRecorded = new Map<string, string>();
  function recordMainAgent(ctx: ExtensionContext, root: string): void {
    try {
      const chatId = ctx.sessionManager.getSessionId();
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
      const entries = ctx.sessionManager.getEntries();
      const stamp = `${entries.length}\0${model}`;
      if (chatsRecorded.get(`${root}\0${chatId}`) === stamp) return;
      recordChat(root, chatId, ctx.sessionManager.getSessionName() ?? null, model, entries);
      chatsRecorded.set(`${root}\0${chatId}`, stamp);
    } catch { /* the page then shows this chat's main agent as it was last saved */ }
  }
  const doing: Record<string, string> = { planning: "planning", review: "reviewing", advisor: "advising", implementation: "coding", testing: "testing" };
  const mark = (event: ProgressEvent) => (event.kind === "rejected" ? "✗" : event.kind === "waicc" ? "◆" : event.kind === "note" ? "·" : "›");
  const stepLine = (event: ProgressEvent) => `${elapsed(event.at).padStart(7)}  ${mark(event)} ${event.text}`;
  const key = (ctx: ExtensionContext): string =>
    `${projectRoot(ctx.cwd)}:${ctx.sessionManager.getSessionId()}`;
  const toLive = (kind: LiveRun["kind"], sessionId: string | null, label: string, startedAt: number, events: ProgressEvent[]): LiveRun => ({
    kind, sessionId, label, startedAt,
    steps: events.filter((event) => event.kind !== "note").slice(-12),
    said: events.findLast((event) => event.kind === "note")?.text ?? null,
  });
  function trackerStatus(ctx: ExtensionContext, root: string, live = true) {
    const runs = live
      ? [
          ...[...dispatches].filter(([, run]) => samePath(run.root, root))
            .map(([id, run]) => ({ ...toLive("dispatch", id, run.label, run.startedAt, run.events), lastActivityAt: run.lastActivityAt, quietAfterMs: run.quietAfterMs })),
          ...[...advising.values()].filter((run) => samePath(run.root, root)),
          ...[...mainTurns.entries()].filter(([chat, turn]) => chat === key(ctx) && samePath(turn.root, root))
            .map(([, turn]) => toLive("main", bindings.get(key(ctx))?.role === "coordinator" ? bindings.get(key(ctx))!.sessionId : null, turn.label, turn.startedAt, turn.events)),
        ]
      : [];
    const binding = bindings.get(key(ctx));
    let budget: number | null = null;
    try {
      budget = sessionBudget(ctx.cwd);
    } catch { /* a broken config is reported where it is used */ }
    return projectStatus(root, runs, notices.get(root) ?? [], binding?.role === "coordinator" ? binding.sessionId : null, budget,
      { ...loadedBuild, outdated: buildOutdated() });
  }
  /** Refreshes this project on the tracker page, at most every 2 s, off WAICC's own path; never fails WAICC. */
  function track(ctx: ExtensionContext, immediately = false, live = true): void {
    try {
      if (!ctx.isProjectTrusted() || bindings.get(key(ctx))?.role === "recipient" || !trackerEnabled()) return;
      const root = projectRoot(ctx.cwd);
      const run = () => {
        trackTimers.delete(root);
        try {
          recordMainAgent(ctx, root);
          const status = trackerStatus(ctx, root, live);
          publish(status);
          if (alertSettings(ctx.cwd).desktop) alertDesktop(status);
        } catch { /* the page is a convenience; WAICC carries on */ }
      };
      if (immediately) return run();
      if (trackTimers.has(root)) return;
      const timer = setTimeout(run, 2_000);
      timer.unref?.();
      trackTimers.set(root, timer);
    } catch { /* as above */ }
  }
  const notice = (ctx: ExtensionContext, level: Notice["level"], text: string) => {
    const root = projectRoot(ctx.cwd);
    notices.set(root, [...(notices.get(root) ?? []), { at: new Date().toISOString(), level, text }].slice(-5));
  };
  function selected(ctx: ExtensionContext, explicit?: string): string {
    const id = explicit || bindings.get(key(ctx))?.sessionId;
    ensure(
      id,
      "No WAICC session selected. Use /waicc-status, then /waicc-use <session-id>, or start /waicc-planning.",
    );
    return id;
  }
  function trusted(ctx: ExtensionContext): void {
    ensure(
      ctx.isProjectTrusted(),
      "Trust the project in Pi before creating or changing project-local WAICC state.",
    );
  }
  function bind(ctx: ExtensionContext, id: string): void {
    loadSession(projectRoot(ctx.cwd), id);
    const previous = bindings.get(key(ctx));
    if (previous?.role === "recipient")
      pi.setActiveTools(previous.previousTools);
    bindings.set(key(ctx), { sessionId: id, role: "coordinator" });
    pi.appendEntry("waicc-session", {
      projectRoot: projectRoot(ctx.cwd),
      sessionId: id,
      role: "coordinator",
    });
  }
  function unbindDeleted(ctx: ExtensionContext, id: string): void {
    if (bindings.get(key(ctx))?.sessionId !== id) return;
    bindings.delete(key(ctx));
    copied.delete(key(ctx));
    pi.appendEntry("waicc-session", {
      projectRoot: projectRoot(ctx.cwd),
      sessionId: null,
      role: "coordinator",
    });
  }
  function coordinator(ctx: ExtensionContext): void {
    ensure(
      bindings.get(key(ctx))?.role !== "recipient",
      "This Pi chat is a handoff recipient. Return to the coordinator for this action; /waicc-use <session-id> explicitly leaves recipient mode.",
    );
  }
  function recipientTools(
    binding: Extract<ChatBinding, { role: "recipient" }>,
  ): void {
    const names = [
      ...recipientReads,
      ...(binding.pin.mode === "implementation" ? ["edit", "write"] : []),
      ...(binding.runChecks || binding.approvedChecks?.length ? ["waicc_check"] : []),
    ];
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    pi.setActiveTools(names.filter((name) => available.has(name)));
  }
  function recipientView(
    ctx: ExtensionContext,
    binding: Extract<ChatBinding, { role: "recipient" }>,
  ): unknown {
    try {
      return recipientAssignment(ctx.cwd, binding.pin);
    } catch (error) {
      return {
        role: "recipient",
        pin: binding.pin,
        stopped: true,
        reason: error instanceof Error ? error.message : String(error),
        nextAction:
          "Stop and return to the coordinator. The pinned request has not been changed.",
      };
    }
  }
  function show(ctx: ExtensionContext, content: unknown): void {
    pi.sendMessage(
      { customType: "waicc", content: json(content), display: true },
      { triggerTurn: false },
    );
  }
  async function copyManual(
    ctx: ExtensionContext,
    delivery: ReturnType<typeof manualHandoff> | null | undefined,
    force = false,
  ): Promise<ClipboardResult | undefined> {
    if (
      !delivery ||
      !ctx.isProjectTrusted() ||
      bindings.get(key(ctx))?.role === "recipient"
    )
      return;
    if (!force && copied.get(key(ctx)) === delivery.requestId)
      return {
        status: "already_copied",
        message:
          "This request was already copied; /waicc-handoff copies it again on demand.",
      };
    const result = await copyHandoffPrompt(
      delivery.copyPastePrompt,
      ctx.mode,
      services.copyText,
    );
    if (result.status === "copied") copied.set(key(ctx), delivery.requestId);
    if (ctx.mode === "tui")
      ctx.ui.notify(
        result.message,
        result.status === "copied" ? "info" : "warning",
      );
    // Without a clipboard, a pointer rather than the whole prompt: the chat stays short.
    if (ctx.mode === "tui" && result.status === "unavailable" && !force)
      ctx.ui.notify("To hand it off by hand, /waicc-handoff shows the prompt; /waicc-dispatch sends it headless.", "info");
    return result;
  }
  async function result(
    content: unknown,
    ctx?: ExtensionContext,
    offerCopy = false,
  ) {
    const clipboard =
      offerCopy && ctx
        ? await copyManual(
            ctx,
            (
              content as {
                manualHandoff?: ReturnType<typeof manualHandoff> | null;
              }
            ).manualHandoff,
          )
        : undefined;
    // The agent never gets the prompt itself, so it cannot paste it into the chat; the human has the clipboard and /waicc-handoff.
    const delivery = (content as { manualHandoff?: ReturnType<typeof manualHandoff> | null } | null)?.manualHandoff;
    const shown = delivery
      ? { ...(content as object), manualHandoff: {
          requestId: delivery.requestId,
          prompt: "Not shown to you. /waicc-handoff shows and copies it for the human; show nextSteps instead.",
          afterReply: delivery.afterReply, resumeCoordinatorCommand: delivery.resumeCoordinatorCommand, continueCommand: delivery.continueCommand,
        } }
      : content;
    const serialized = json(
      clipboard
        ? { handoffClipboard: clipboard, ...(shown as object) }
        : shown,
    );
    return {
      content: [
        {
          type: "text" as const,
          text:
            serialized.length <= 32_000
              ? serialized
              : `${serialized.slice(0, 32_000)}\n[Preview bounded; inspect the session files for the full artifact.]`,
        },
      ],
      details: clipboard ? { clipboard } : {},
    };
  }
  function command(
    name: string,
    description: string,
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  ): void {
    // Resolves to the error the human was shown, or null: waicc_suggest_command reports it.
    const run = async (args: string, ctx: ExtensionCommandContext): Promise<string | null> => {
        // A line above the input box while the command runs, so a slow one does not look hung.
        // RPC clients can show widgets too; print mode has no UI.
        const busy = ctx.hasUI;
        const mark = (lines: string[] | undefined) => {
          try { ctx.ui.setWidget("waicc-busy", lines); } catch { /* only a hint; the command runs without it */ }
        };
        try {
          if (busy) {
            mark([`⏳ WAICC: running /${name}…`]);
            // Snapshots and session files are read synchronously: let Pi draw the line before that starts.
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          trusted(ctx);
          automaticRequests.clear(ctx); // Human commands supersede any pending startup decision.
          if (
            ![
              "waicc-receive",
              "waicc-status",
              "waicc-list",
              "waicc-use",
              "waicc-close",
              "waicc-force-close",
              "waicc-memory",
              "waicc-compact",
            ].includes(name)
          )
            coordinator(ctx);
          await handler(args.trim(), ctx);
          if (["waicc-review", "waicc-advisor", "waicc-help-develop", "waicc-implement", "waicc-test"].includes(name)) {
            const binding = bindings.get(key(ctx));
            if (binding?.role === "coordinator") {
              const view = status(ctx.cwd, binding.sessionId) as {
                manualHandoff: ReturnType<typeof manualHandoff> | null;
              };
              await copyManual(ctx, view.manualHandoff);
            }
          }
          return null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(message, "error");
          return message;
        } finally {
          if (busy) mark(undefined);
          track(ctx);
        }
    };
    commands.set(name, run);
    pi.registerCommand(name, { description, handler: async (args, ctx) => void (await run(args, ctx)) });
  }
  /** Your standing policies for the main agent's instructions; a broken config is reported elsewhere. */
  function policiesFor(ctx: ExtensionContext): string {
    try {
      const text = policyGuidance(decisionSettings(ctx.cwd).policies);
      return text ? `\n\n${text}` : "";
    } catch {
      return "";
    }
  }
  /** Your autoDecide setting: accept qualifying recommendations, and say so. Returns what it accepted. */
  function autoResolve(ctx: ExtensionContext, id: string): string[] {
    let enabled = false;
    try {
      enabled = decisionSettings(ctx.cwd).autoDecide === "low-risk";
    } catch {
      return [];
    }
    if (!enabled) return [];
    let decisions: ContractDecision[] = [];
    try {
      decisions = readContract(ctx.cwd, id).contract.decisions ?? [];
    } catch {
      return [];
    }
    const accepted: string[] = [];
    for (const decision of decisions.filter((d) => autoDecidable(d).ok)) {
      try {
        resolveDecision(ctx.cwd, id, decision.id, decision.recommendation, { kind: "auto-low-risk" });
        accepted.push(`${decision.id}: ${decision.question} → ${decision.recommendation}`);
      } catch {
        break; // For example a pending handoff: the next assessment tries again.
      }
    }
    if (accepted.length) {
      const message = `Accepted automatically under your autoDecide setting (low risk, reversible, nothing sensitive):\n${accepted.map((line) => `• ${line}`).join("\n")}\nReview with /waicc-decisions. Everything else still waits for you.`;
      ctx.ui.notify(`${accepted.length} low-risk decision${accepted.length === 1 ? "" : "s"} accepted automatically.`, "info");
      pi.sendMessage({ customType: "waicc-auto-decisions", content: message, display: true }, { triggerTurn: false });
    }
    return accepted;
  }
  /** By chat: a compaction WAICC asked Pi for, settled when Pi reports it done or failed. */
  const compactions = new Map<string, Promise<void>>();
  /** Ask Pi to compact this chat with WAICC's recovery kept; WAICC's own prompts wait for it. */
  function compactChat(ctx: ExtensionContext, recovery: unknown, done: { complete: string; failed: (message: string) => string }): void {
    const chat = key(ctx);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    compactions.set(chat, settled);
    const finish = (message: string, level: "info" | "warning" | "error") => {
      if (compactions.get(chat) === settled) compactions.delete(chat);
      settle();
      ctx.ui.notify(message, level);
    };
    ctx.compact({
      customInstructions: compactionInstructions(recovery),
      onComplete: () => finish(done.complete, "info"),
      onError: (error) => finish(done.failed(error.message), "error"),
    });
  }
  async function prompt(
    ctx: ExtensionCommandContext,
    instruction: string,
    focus = "",
  ): Promise<void> {
    // Pi refuses a prompt while it compacts: a reply that arrives meanwhile waits its turn.
    await compactions.get(key(ctx));
    const id = selected(ctx);
    // Recall by the user's own words, not this fixed instruction text.
    const saved = loadSession(projectRoot(ctx.cwd), id);
    const query = `${requirementsText(saved)}\n${focus}`;
    const recovery = checkpointView(projectRoot(ctx.cwd), saved, snapshot(ctx.cwd).fingerprint, false);
    await pi.sendUserMessage(
      `${guidance}${policiesFor(ctx)}\n\n${instruction}\n\nSession recovery (index, not a substitute for the exact contract/reply; use waicc_status when assessing):\n${json({ ...recovery, requirementsPreview: requirementsText(saved).slice(0, 2400), advisor: saved.rounds.at(-1)?.advisor })}\n\nRelevant confirmed project memory:\n${json(recall(ctx.cwd, query))}`,
      { deliverAs: "followUp" },
    );
  }
  return { pi, services, bindings, copied, commands, compactedRuns, automaticRequests, registerTool, dispatches, advising, mainTurns, notices, trackTimers, alertDesktop, outdatedWarned, warnOutdated, chatsRecorded, recordMainAgent, doing, mark, stepLine, key, toLive, trackerStatus, track, notice, selected, trusted, bind, unbindDeleted, coordinator, recipientTools, recipientView, show, copyManual, result, command, policiesFor, autoResolve, prompt, compactions, compactChat };
}
export type Core = ReturnType<typeof createApp>;
export type App = Core & Runs;
