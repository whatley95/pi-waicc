import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadSession, readText } from "../files.ts";
import { join } from "node:path";
import { configureSvnIgnore } from "../ignore.ts";
import { commandText } from "../dispatch.ts";
import { codingAgent, initAgentConfig, profilesView, projectConfigPath, resolveDispatch } from "../profiles.ts";
import { elapsed } from "../progress.ts";
import { auditMemory, curate, memoryStates, recall } from "../memory.ts";
import { projectRoot } from "../source.ts";
import type { manualHandoff } from "../render.ts";
import { amend, readContract, cancel, closeSession, exportHandoff, forceCloseSession, reopenSession, setRoundLimit, status } from "../workflow.ts";
import { ensure } from "../validation.ts";
import { authorizationState } from "../state.ts";
import type { RoundPhase } from "../types.ts";
import { sessionCommandInput } from "./shared.ts";
import type { App } from "./app.ts";

/** /waicc-dispatch, and the commands that select, close, reopen, cancel, amend, export or limit a session, plus memory. */
export function registerDispatchCommands(app: App): void {
  const { pi, dispatches, stepLine, selected, bind, coordinator, show, copyManual, command, prompt, loops, loopName, endLoop, launch } = app;
  command(
    "waicc-dispatch",
    "Run the waiting handoff in a headless agent: [profile] [--via claude|codex|pi|agy] [--model <model>] [--effort <level>] [--timeout <minutes>] [--implement] [--check \"<command>\"]... [--check-timeout <minutes>] [--continue|-c|--no-continue] [--loop [cycles]] [--develop [--review|--review-with <profile>]] [--auto] [--plan-with <profile>] [--code-with [<profile>]] [--review-once] | --progress | --profiles | --init-profiles | --stop",
    async (args, ctx) => {
      if (args === "--profiles") {
        show(ctx, profilesView(ctx.cwd));
        return;
      }
      if (args === "--init-profiles") {
        show(ctx, initAgentConfig());
        return;
      }
      const id = selected(ctx);
      if (args === "--progress") {
        const running = dispatches.get(id);
        ensure(running, "No dispatched agent is running for this session. A finished run's steps are in its dispatch log (result.json, progress).");
        pi.sendMessage({
          customType: "waicc-dispatch-progress",
          content: [`${running.label} · ${elapsed(Date.now() - running.startedAt)}`, ...running.events.map(stepLine)].join("\n") || running.label,
          display: true,
        }, { triggerTurn: false });
        return;
      }
      if (args === "--stop") {
        const running = dispatches.get(id);
        const looping = loops.get(id);
        ensure(running || looping, "No dispatched recipient or loop is running for this session in this Pi process.");
        if (looping) endLoop(ctx, id, `${loopName(looping)} stopped by you at cycle ${looping.cycle}/${looping.max}.`);
        running?.controller.abort();
        await running?.done;
        return;
      }
      ensure(!dispatches.has(id), "A dispatched recipient is already running for this session. Use /waicc-dispatch --stop first.");
      // No agent typed: the waiting handoff's role picks a profile from the agent config.
      const resolved = resolveDispatch(ctx.cwd, id, args);
      const waiting = loadSession(projectRoot(ctx.cwd), id).rounds.find((round) => round.status === "WAITING");
      ensure(!resolved.options.review || resolved.options.develop, "--review continues a planning run through development into the code review, so it needs --develop.");
      ensure(!resolved.options.ship || waiting?.mode !== "planning" || resolved.options.develop, "--ship ships the change once its code review passes, so on a planning handoff it needs --auto (or --develop --review).");
      if (resolved.options.develop) {
        ensure(waiting?.mode === "planning", "--develop starts development when a plan is accepted, so it needs a waiting planning handoff.");
        ensure(resolved.options.continue !== false, "--develop needs the continue step; drop --no-continue.");
      }
      // The coding agent is checked now, not after the plan is accepted.
      if (resolved.options.codeWith) codingAgent(ctx.cwd, typeof resolved.options.codeWith === "string" ? resolved.options.codeWith : undefined);
      if (resolved.options.loop) ensure(waiting?.mode === "planning" || (waiting?.mode === "review" && waiting.review?.kind === "code"),
        "--loop needs a waiting planning handoff (plan → assess → revise) or code review (review → fix → re-review).");
      if (resolved.options.loop && waiting?.mode === "review") {
        // The main agent fixes between reviews, so it must be allowed to: say so now, not after a cycle.
        const s = loadSession(projectRoot(ctx.cwd), id);
        const authorization = authorizationState(s, readContract(ctx.cwd, id).contract);
        ensure(authorization.authorized, `--loop needs development authorization, because the main agent fixes findings between reviews. ${authorization.reason}`);
        ensure((s.implementationOwner ?? "main") === "main", "--loop has the main agent fix findings between reviews, but implementation is delegated in this session. Switch with /waicc-help-develop --main, or dispatch reviews yourself.");
      }
      if (resolved.confirmChecks) {
        ensure(ctx.hasUI, "These checks come from the project's agent config, and confirming them needs interactive Pi. Pass --check yourself, or move them to your user config.");
        const approved = await ctx.ui.confirm(
          "Run these checks from the project's agent config?",
          `${resolved.options.checks!.map(commandText).join("\n")}\n\nThey come from ${projectConfigPath(projectRoot(ctx.cwd))}, which anyone who can change the repository can edit. They run with your account's permissions. Approve only local, reviewed commands.`,
        );
        ensure(approved, "Dispatch cancelled: the project's checks were not approved.");
      }
      // --develop without --loop is a single planning cycle.
      if (resolved.options.loop || resolved.options.develop)
        loops.set(id, {
          options: resolved.options, profile: resolved.profile, cycle: 1, max: resolved.options.loop ?? 1,
          mode: waiting!.mode === "planning" ? "planning" : "review", develop: Boolean(resolved.options.develop),
          phase: "reviewing", requestId: "", findings: null,
          ...(resolved.options.review ? { review: { profile: resolved.options.reviewWith } } : {}),
          ...(resolved.options.codeWith ? { code: { profile: typeof resolved.options.codeWith === "string" ? resolved.options.codeWith : undefined } } : {}),
          ...(resolved.options.reviewOnce ? { reviewMax: 1 } : {}),
          ...(resolved.options.ship ? { ship: true } : {}),
        });
      try {
        launch(ctx, id, resolved.options, resolved.profile);
      } catch (error) {
        loops.delete(id);
        throw error;
      }
    },
  );
  command(
    "waicc-use",
    "Bind this Pi chat to an existing project session UUID",
    async (args, ctx) => {
      bind(ctx, args);
      show(ctx, status(ctx.cwd, args));
    },
  );
  const closed = (ctx: ExtensionCommandContext, id: string) => show(ctx, status(ctx.cwd, id));
  command(
    "waicc-close",
    "Close a reviewed contract, or [session-id] --force [reason] to stop it without review approval (human action)",
    async (args, ctx) => {
      const forceFirst = /^--force(?:\s|$)/.test(args);
      const input = sessionCommandInput(
        forceFirst ? args.slice("--force".length).trim() : args,
      );
      const forceAfter = /^--force(?:\s|$)/.test(input.remainder);
      if (forceFirst || forceAfter) {
        const id = selected(ctx, input.id);
        forceCloseSession(
          ctx.cwd,
          id,
          (forceAfter
            ? input.remainder.slice("--force".length).trim()
            : input.remainder) || undefined,
        );
        closed(ctx, id);
      } else {
        coordinator(ctx);
        const id = selected(ctx, input.id);
        closeSession(ctx.cwd, id, input.remainder);
        closed(ctx, id);
      }
    },
  );
  command(
    "waicc-force-close",
    "Stop a contract immediately: [session-id] [reason]; no review or reason required (human action)",
    async (args, ctx) => {
      const input = sessionCommandInput(args);
      const id = selected(ctx, input.id);
      forceCloseSession(ctx.cwd, id, input.remainder || undefined);
      closed(ctx, id);
    },
  );
  command(
    "waicc-reopen",
    "Explicitly reopen a closed contract: [session-id] <reason>; requires fresh review (human action)",
    async (args, ctx) => {
      const input = sessionCommandInput(args);
      const id = selected(ctx, input.id);
      ensure(input.remainder.trim(), `Say why it is reopened: /waicc-reopen ${input.id ?? "[session-id]"} <reason>, for example /waicc-reopen ${id} The client asked for CSV export too`);
      reopenSession(ctx.cwd, id, input.remainder);
      bind(ctx, id);
      show(ctx, status(ctx.cwd, id));
    },
  );
  command(
    "waicc-cancel",
    "Cancel a pending handoff: [session-id] [reason]; defaults to the selected session and a recorded user-cancellation reason",
    async (args, ctx) => {
      const input = sessionCommandInput(args);
      const id = selected(ctx, input.id);
      cancel(ctx.cwd, id, input.remainder || undefined);
      show(ctx, status(ctx.cwd, id));
    },
  );
  command(
    "waicc-amend",
    "Append a requirement amendment and invalidate affected pending requests",
    async (args, ctx) => {
      const s = amend(ctx.cwd, selected(ctx), args);
      await prompt(
        ctx,
        `Requirements were amended. Inspect the amendment and revise the contract. Session ${s.id}.`,
      );
    },
  );
  command(
    "waicc-export",
    "Export the pending handoff and required guidance for another checkout/agent",
    async (_args, ctx) => {
      const exportPath = exportHandoff(ctx.cwd, selected(ctx));
      const view = status(ctx.cwd, selected(ctx)) as {
        manualHandoff: ReturnType<typeof manualHandoff> | null;
      };
      const clipboard = view.manualHandoff
        ? await copyManual(
            ctx,
            {
              ...view.manualHandoff,
              copyPastePrompt: readText(join(exportPath, "STARTER.txt")),
            },
            true,
          )
        : undefined;
      show(ctx, {
        exportPath,
        handoffClipboard: clipboard,
        includesSourceCode: false,
        whatToSend:
          "Provide the ENTIRE export folder and paste the CONTENTS of its STARTER.txt. The recipient also needs matching project source; the bundle does not include code. Review content before sharing. Return its reply.json to the original round, then /waicc-continue in the coordinator.",
      });
    },
  );
  command(
    "waicc-limit",
    "Explicitly set overall or phase round budget: [phase] <2–20>",
    async (args, ctx) => {
      const parts = args.split(/\s+/);
      ensure(parts.length === 1 || parts.length === 2, "Usage: /waicc-limit [specification|implementation|testing|code_review|advisor] <2-20>");
      setRoundLimit(ctx.cwd, selected(ctx), Number(parts.at(-1)), parts.length === 2 ? parts[0] as RoundPhase : undefined);
      show(ctx, status(ctx.cwd, selected(ctx)));
    },
  );
  command(
    "waicc-ignore",
    "Configure SVN ignore while preserving existing rules (Git is automatic)",
    async (_args, ctx) => show(ctx, configureSvnIgnore(projectRoot(ctx.cwd))),
  );
  command(
    "waicc-memory",
    "List candidates, or confirm/revoke entries: confirm|revoke [<id>|all]; with no ID, pick from a list. audit: replay the corroboration rule against what you confirmed and revoked",
    async (args, ctx) => {
      const [action, id, ...extra] = args.split(/\s+/);
      if (action === "audit" && !id) {
        show(ctx, auditMemory(ctx.cwd));
        return;
      }
      if (action !== "confirm" && action !== "revoke") {
        show(ctx, recall(ctx.cwd, args, true));
        return;
      }
      coordinator(ctx);
      ensure(extra.length === 0, `Usage: /waicc-memory ${action} [<id>|all]`);
      const entries = memoryStates(ctx.cwd);
      // Confirm candidates; revoke anything not yet revoked. A stale entry's source changed.
      const targets = entries.filter((entry) => (action === "confirm" ? entry.state === "candidate" : entry.state !== "revoked"));
      const label = (entry: (typeof entries)[number]) => `${entry.kind}: ${entry.text} (from ${entry.source})`;
      const stale = entries.filter((entry) => entry.state === "stale" && !entry.confirmedAt).length;
      const listed = targets.length
        ? `${action === "confirm" ? "Candidates" : "Entries"}: ${targets.map((entry) => `${entry.id} ${label(entry)}`).join("; ")}.`
        : `There is nothing to ${action}.`;
      const staleNote = action === "confirm" && stale ? ` ${stale} stale candidate${stale === 1 ? "" : "s"} cannot be confirmed: ${stale === 1 ? "its" : "their"} source changed, so propose a fresh one.` : "";
      let chosen: typeof targets;
      if (id === "all") {
        ensure(targets.length, listed + staleNote);
        if (ctx.hasUI)
          ensure(await ctx.ui.confirm(`${action === "confirm" ? "Confirm" : "Revoke"} all ${targets.length}?`,
            `${targets.map((entry) => `• ${label(entry)}`).join("\n")}${action === "confirm" ? "\n\nConfirmed memory goes into every future handoff in this project." : ""}`), "Nothing changed.");
        chosen = targets;
      } else if (id) {
        const entry = entries.find((row) => row.id === id);
        ensure(entry, `Unknown memory ID ${JSON.stringify(id)}. ${listed}${staleNote}`);
        chosen = [entry];
      } else {
        ensure(targets.length, listed + staleNote);
        ensure(ctx.hasUI, `Usage: /waicc-memory ${action} <id>|all. ${listed}${staleNote}`);
        const labels = [...targets.map(label), ...(targets.length > 1 ? [`All ${targets.length} of them`] : [])];
        const picked = await ctx.ui.select(`Which entry do you want to ${action}?`, labels);
        ensure(picked, "Nothing changed.");
        chosen = picked === labels.at(-1) && targets.length > 1 ? targets : [targets[labels.indexOf(picked)]];
      }
      show(ctx, chosen.map((entry) => curate(ctx.cwd, entry.id, action)));
    },
  );
}
