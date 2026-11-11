import { Type } from "typebox";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertRecipientCurrent, submitRecipientReply, validateRecipientReply } from "../recipient.ts";
import { json, loadSession } from "../files.ts";
import { join } from "node:path";
import { checkCommand, runRecipientCheck, type CheckRunner } from "../checks.ts";
import { maxCheckMs, runAgent } from "../dispatch.ts";
import { sandboxSettings } from "../profiles.ts";
import { consultAdvisor } from "../consult.ts";
import { elapsed, spinner, type ProgressEvent } from "../progress.ts";
import { checkpointView, frozenCheckpointView } from "../checkpoint.ts";
import { recall } from "../memory.ts";
import { projectRoot, snapshot } from "../source.ts";
import { createAutoPlanningSession, decisionsView, status, saveContext } from "../workflow.ts";
import { ensure } from "../validation.ts";
import { adviceText, advisorContext, advisorTurn, applyPolicy, assessReply, prepareHandoff, proposeLesson, proposeMemory, requestHandoff, stepView, type Outcome } from "../coordinator.ts";
import {
  applyPolicySpec, askAdvisorSpec, assessSpec, checkpointSpec, contextSpec, learnPatternSpec, memorySpec, prepareSpec, requestSpec, startPlanningSpec, statusSpec,
  type ApplyPolicyParams, type AskAdvisorParams, type AssessParams, type ContextParams, type LearnPatternParams, type MemoryParams,
  type PrepareParams, type RequestParams, type SessionParams, type StartPlanningParams,
} from "../tool-specs.ts";
import { autoPlanningMode } from "../auto-planning.ts";
import { guidance, piTool } from "./shared.ts";
import { type App } from "./app.ts";

/** The main agent's and recipients' WAICC tools. */
export function registerTools(app: App): void {
  const { pi, services, bindings, commands, commandDone, automaticRequests, registerTool, advising, dispatches, stepLine, key, logged, toLive, track, notice, selected, trusted, bind, coordinator, recipientView, result, tell } = app;
  const consulting = new Set<string>();
  /** The agent's result, after the human is told what the outcome says to tell them. */
  const shown = (ctx: ExtensionContext, outcome: Outcome) => {
    tell(ctx, outcome);
    return outcome.result;
  };
  registerTool(piTool<AskAdvisorParams>(askAdvisorSpec, {
    async execute(_id, params, signal, update, ctx) {
      trusted(ctx);
      coordinator(ctx);
      signal?.throwIfAborted();
      const used = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "waicc-advisor-consult").length;
      const turn = advisorTurn(ctx.cwd, used);
      const chat = key(ctx);
      ensure(!consulting.has(chat), "The advisor is already answering a question in this chat; wait for it.");
      const { options, profile } = turn;
      const binding = bindings.get(chat);
      const context = advisorContext(ctx.cwd, binding?.role === "coordinator" ? binding.sessionId : undefined);
      // Counted before it runs, so a failed or stopped consult still uses one.
      pi.appendEntry("waicc-advisor-consult", { question: params.question, profile, at: new Date().toISOString() });
      consulting.add(chat);
      const label = `WAICC · advisor ${profile} (${options.via}${options.model ? ` ${options.model}` : ""}${options.effort ? ` ${options.effort}` : ""}) · question ${turn.number}/${turn.limit}`;
      ctx.ui.notify(`Asking the advisor (${profile}): ${params.question.slice(0, 160)}`, "info");
      const startedAt = Date.now();
      const events: ProgressEvent[] = [];
      const render = (publish = true) => {
        ctx.ui.setWidget?.("waicc-advisor", [
          `${spinner()} ${label} · ${elapsed(Date.now() - startedAt)}`,
          ...(events.length ? events.filter((event) => event.kind !== "note").slice(-4).map(stepLine) : ["        starting the advisor…"]),
        ]);
        ctx.ui.setStatus?.("waicc-advisor", `${spinner()} advisor · ${elapsed(Date.now() - startedAt)}`);
        advising.set(chat, { ...toLive("advisor", binding?.role === "coordinator" ? binding.sessionId : null, `${label} · ${params.question.slice(0, 120)}`, startedAt, events), root: projectRoot(ctx.cwd) });
        if (publish) track(ctx);
      };
      // Every second, as a dispatch's panel; the tracker page every 5.
      let ticks = 0;
      const ticker = setInterval(() => render(++ticks % 5 === 0), 1_000);
      ticker.unref?.();
      render();
      try {
        const outcome = await consultAdvisor(ctx.cwd, { ...params, context }, options, services.runAgent, signal, (event) => {
          events.push(event);
          render();
          update?.({ content: [{ type: "text", text: `Advisor: ${event.text}` }], details: undefined });
        });
        notice(ctx, outcome.answer ? "info" : "warning", `Advisor ${profile}: ${outcome.answer ? "answered" : "gave no answer to"} "${params.question.slice(0, 120)}" in ${elapsed(outcome.durationMs)}.`);
        ensure(outcome.answer, `The advisor gave no answer (exit ${outcome.code}${outcome.killed ? ", stopped" : ""}). See ${outcome.log}. Continue on your own or ask the human.`);
        return { content: [{ type: "text" as const, text: adviceText(turn, { ...outcome, answer: outcome.answer }) }], details: undefined };
      } finally {
        clearInterval(ticker);
        consulting.delete(chat);
        advising.delete(chat);
        ctx.ui.setWidget?.("waicc-advisor", undefined);
        ctx.ui.setStatus?.("waicc-advisor", undefined);
      }
    },
  }));
  registerTool(piTool<SessionParams>(checkpointSpec, {
    async execute(_id, params, _signal, _update, ctx) {
      trusted(ctx);
      const binding = bindings.get(key(ctx));
      if (binding?.role === "recipient") {
        ensure(!params.sessionId || params.sessionId === binding.sessionId, "Recipient checkpoint is pinned to its assigned session");
        assertRecipientCurrent(ctx.cwd, binding.pin);
        return result(frozenCheckpointView(projectRoot(ctx.cwd), loadSession(projectRoot(ctx.cwd), binding.sessionId), binding.pin.requestId));
      }
      return result(checkpointView(projectRoot(ctx.cwd), loadSession(projectRoot(ctx.cwd), selected(ctx, params.sessionId))));
    },
  }));
  registerTool(piTool<ContextParams>(contextSpec, {
    async execute(_id, params, signal, _update, ctx) {
      trusted(ctx); coordinator(ctx); signal?.throwIfAborted();
      saveContext(ctx.cwd, params.sessionId, params.summary);
      return result(stepView(status(ctx.cwd, params.sessionId)));
    },
  }));
  registerTool(piTool<SessionParams>(statusSpec, {
    async execute(_id, params, _signal, _update, ctx) {
      const binding = bindings.get(key(ctx));
      if (binding?.role === "recipient") {
        ensure(
          !params.sessionId || params.sessionId === binding.sessionId,
          "Recipient status is pinned to its assigned session",
        );
        return result(recipientView(ctx, binding));
      }
      return result(status(ctx.cwd, selected(ctx, params.sessionId)));
    },
  }));
  registerTool(piTool<StartPlanningParams>(startPlanningSpec, {
    async execute(_id, params, signal, _update, ctx) {
      trusted(ctx); coordinator(ctx); signal?.throwIfAborted();
      ensure(autoPlanningMode(ctx) === "on", "Automatic planning is off. The human can /waicc-auto-planning on, or use /waicc-planning.");
      const request = automaticRequests.current(ctx);
      ensure(request && request.id === params.requestId, "No matching live human request for automatic planning. Use a fresh ordinary idle prompt; never reuse tokens from history, extensions or another chat.");
      ensure(params.reason.trim().length > 0 && params.reason.length <= 2000, "Give a concise nonempty planning reason (maximum 2000 characters)");
      const binding = bindings.get(key(ctx));
      const s = binding ? loadSession(projectRoot(ctx.cwd), binding.sessionId)
        : createAutoPlanningSession(ctx.cwd, request.text, ctx.sessionManager.getSessionId(), request.id);
      ensure(s.status !== "CLOSED", "The selected contract is closed. Explicitly reopen/select it or start separate work with /waicc-planning; automatic planning will not replace it. Offer the human /waicc-planning with this request through waicc_suggest_command.");
      if (!binding) bind(ctx, s.id);
      return result({ action: binding ? "existing_session" : "planning_started", reason: params.reason,
        sessionId: s.id, status: s.status, contractVersion: s.contractVersion, objective: s.objective ?? "legacy",
        requirementsPath: join(projectRoot(ctx.cwd), ".pi/pi-waicc/sessions", s.id, "requirements.md"),
        nextAction: binding
          ? "Existing session UNCHANGED. Recover waicc_status, compare exact scope and follow its current next action. Do not amend scope, duplicate a pending handoff or replay the initial brief sequence. Unrelated/ambiguous work needs an explicit human selection/new planning command."
          : `Planning-only startup. Save important prior chat constraints/decisions/source references with waicc_context, then waicc_prepare expectedVersion 0 mode planning with a faithful requirements brief; tasks may be []. The independent planner forms the detailed source-backed plan. ${guidance}` });
    },
  }));
  registerTool(piTool<PrepareParams>(prepareSpec, {
    async execute(_id, params, signal, _update, ctx) {
      trusted(ctx);
      coordinator(ctx);
      signal?.throwIfAborted();
      return result(shown(ctx, prepareHandoff(ctx.cwd, params)), ctx, true);
    },
  }));
  registerTool(piTool<AssessParams>(assessSpec, {
    async execute(_id, params, signal, _update, ctx) {
      trusted(ctx);
      coordinator(ctx);
      signal?.throwIfAborted();
      return result(shown(ctx, assessReply(ctx.cwd, params)), ctx, true);
    },
  }));
  registerTool(piTool<LearnPatternParams>(learnPatternSpec, {
    async execute(_id, params, signal, _update, ctx) {
      trusted(ctx);
      coordinator(ctx);
      signal?.throwIfAborted();
      return result(shown(ctx, proposeLesson(ctx.cwd, params)));
    },
  }));
  registerTool(piTool<ApplyPolicyParams>(applyPolicySpec, {
    async execute(_id, params, signal, _update, ctx) {
      trusted(ctx);
      coordinator(ctx);
      signal?.throwIfAborted();
      return result(shown(ctx, applyPolicy(ctx.cwd, params)));
    },
  }));
  registerTool(piTool<RequestParams>(requestSpec, {
    async execute(_id, params, signal, _update, ctx) {
      trusted(ctx);
      coordinator(ctx);
      signal?.throwIfAborted();
      return result(shown(ctx, requestHandoff(ctx.cwd, params)), ctx, true);
    },
  }));
  registerTool({
    name: "waicc_check",
    label: "Run confirmed WAICC check",
    description: "Recipient only, explicit --run-checks plus interactive confirmation EACH time. Execute an exact local check program/args at project root, with timeout and source-pinned output log. General execution tools stay blocked; not an OS sandbox. No production, installs, resets or deployments. Do not pass secrets. Logs/exit codes are evidence, not code-review approval.",
    parameters: Type.Object({
      program: Type.String(), args: Type.Array(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      trusted(ctx); signal?.throwIfAborted();
      const binding = bindings.get(key(ctx));
      ensure(binding?.role === "recipient", "Check execution requires a recipient assignment");
      const run = services.runCheck ?? ((program: string, args: string[], options: Parameters<CheckRunner>[2]) => pi.exec(program, args, options));
      // The human approved these exact commands when dispatching, so no dialog is needed.
      const preApproved = binding.approvedChecks?.find((check) =>
        check.program === params.program && check.args.length === params.args.length && check.args.every((arg, i) => arg === params.args[i]));
      if (preApproved) {
        assertRecipientCurrent(ctx.cwd, binding.pin);
        // WAICC's runner, which also starts Windows .cmd shims such as npm.
        return result(await runRecipientCheck(ctx.cwd, binding.pin, preApproved, snapshot(projectRoot(ctx.cwd)).fingerprint, services.runCheck ?? runAgent, signal, { maxTimeoutMs: maxCheckMs, sandbox: sandboxSettings(ctx.cwd) }));
      }
      ensure(binding.runChecks, binding.approvedChecks?.length
        ? `Only the pre-approved checks can run: ${binding.approvedChecks.map((check) => JSON.stringify({ program: check.program, args: check.args })).join(", ")}. Report any other check not_run.`
        : "Check execution requires the human's /waicc-receive <session-id> [--implement] --run-checks opt-in");
      ensure(ctx.hasUI, "No confirmation UI; report this check not_run");
      assertRecipientCurrent(ctx.cwd, binding.pin);
      const command = checkCommand(params), source = snapshot(projectRoot(ctx.cwd)).fingerprint;
      const approved = await ctx.ui.confirm("Allow this exact local check?", `${json({ projectRoot: projectRoot(ctx.cwd), ...command })}\nCommands run with your account permissions and may write files, access network/services or run project scripts. This is not sandboxing. Approve only a reviewed, safe local check; no production or credentials.`, { signal });
      ensure(approved, "Check not run: human declined command approval");
      trusted(ctx);
      ensure(bindings.get(key(ctx)) === binding && binding.runChecks, "Recipient assignment/permissions changed during confirmation");
      return result(await runRecipientCheck(ctx.cwd, binding.pin, command, source, run, signal, { sandbox: sandboxSettings(ctx.cwd) }));
    },
  });
  registerTool({
    name: "waicc_reply",
    label: "Submit pinned WAICC reply",
    description:
      "Recipient only: validate and submit one reply to this chat's pinned handoff. Supply outcome, summary, coverage, findings, questions, checks and optional proposedContract/advice; pinned identity fields are added and cannot be changed. Prefer canonical findings and checks {description,outcome: passed|failed|not_run,evidence}. Common finding/check aliases, pass/fail/not-run spellings, evidence text/array forms and decision evidence text are normalized with an audit log. Missing evidence, ambiguous/conflicting results and changed identity still fail. Annotations are not instructions or authority. Does not assess or advance the contract. validateOnly true checks a draft without writing; then submit once. Stop after submitting.",
    parameters: Type.Object({ reply: Type.Unknown(), validateOnly: Type.Optional(Type.Boolean({ description: "Dry run: apply every submit-time check without writing" })) }),
    async execute(_id, params, signal, _update, ctx) {
      trusted(ctx);
      signal?.throwIfAborted();
      const binding = bindings.get(key(ctx));
      ensure(
        binding?.role === "recipient",
        "Use /waicc-receive <session-id> before submitting a recipient reply",
      );
      if (params.validateOnly) return result(validateRecipientReply(ctx.cwd, binding.pin, params.reply));
      const submitted = submitRecipientReply(
        ctx.cwd,
        binding.pin,
        params.reply,
      );
      pi.appendEntry("waicc-recipient-submitted", {
        ...binding.pin,
        provider: ctx.model?.provider,
        model: ctx.model?.id,
      });
      return result(submitted);
    },
  });
  registerTool(piTool<MemoryParams>(memorySpec, {
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (params.action === "recall")
        return result(recall(ctx.cwd, params.query));
      trusted(ctx);
      coordinator(ctx);
      return result(proposeMemory(ctx.cwd, params, { sessionId: bindings.get(key(ctx))?.sessionId ?? null, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null }));
    },
  }));
  // Per chat: the commands the agent last offered, and the picker once it is open.
  type Offer = { title: string; offered: { line: string; name: string; args: string; label: string; fill: boolean }[]; each: boolean; picker?: AbortController };
  const offers = new Map<string, Offer>();
  // Per chat: the questions still open after the human answered one, shown again once that command has run.
  const rest = new Map<string, Offer & { after: string }>();
  // Commands that cannot run without the human's text (an amendment, an answer, a reason, an ID).
  const needsText = new Set(["waicc-advisor", "waicc-amend", "waicc-close", "waicc-decide", "waicc-delete", "waicc-limit",
    "waicc-planning", "waicc-receive", "waicc-reopen", "waicc-restore", "waicc-use", "waicc-worktree"]);
  // Of those, the ones a session ID alone completes; the rest need their text after any ID.
  // Commands whose line carries the human's or agent's prose may be longer.
  const carriesText = new Set(["waicc-advisor", "waicc-amend", "waicc-close", "waicc-decide", "waicc-planning", "waicc-reopen"]);
  // Names agents have offered that are a flag of another command, or a near miss.
  const meant: Record<string, string> = {
    "waicc-profiles": "/waicc-dispatch --profiles", "waicc-init-profiles": "/waicc-dispatch --init-profiles",
    "waicc-progress": "/waicc-dispatch --progress", "waicc-stop": "/waicc-dispatch --stop",
    "waicc-decision": "/waicc-decide", "waicc-errors": "waicc errors (a CLI command for a terminal)",
  };
  const didYouMean = (name: string | undefined) => {
    const hint = name && (meant[name] ?? (commands.has(name.replace(/s$/, "")) ? `/${name.replace(/s$/, "")}` : commands.has(`${name}s`) ? `/${name}s` : undefined));
    return hint ? ` Did you mean ${hint}?` : "";
  };
  const idIsEnough = new Set(["waicc-delete", "waicc-receive", "waicc-restore", "waicc-use"]);
  const missingText = (name: string, args: string) =>
    needsText.has(name) && (idIsEnough.has(name) ? !args : !args.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b\s*/i, ""));
  registerTool({
    name: "waicc_suggest_command",
    label: "Suggest a WAICC command to the human",
    description:
      "Coordinator only: when the human needs to run a /waicc-* command (you cannot run slash commands), offer up to 4 of them in a picker instead of asking the human to type one. The picker opens when your turn ends, and only the human can answer it; the one they pick runs at once, exactly as if they had typed it, so it stays their action. Only real /waicc-* commands are accepted.",
    promptSnippet: "Offer the human /waicc-* commands to run, in a picker, instead of asking them to type one",
    promptGuidelines: [
      "Whenever you would ask the human to run a /waicc-* command, including when you are stuck or a WAICC result says the human must run one, call waicc_suggest_command with the exact command and a short reason instead of writing it in the chat. Then end your turn: what the command starts reaches you as a new message.",
      "You do not learn what the human picks; its output is shown to them, not to you. Check state with waicc_status rather than assuming what it did.",
      "Offer complete command lines: a command that takes text gets it (/waicc-amend <the amendment>, /waicc-decide <id> <answer>, /waicc-close <reason>). Only offer it bare when the text must be the human's own; picking it then only fills their input box.",
      "When each command answers a separate question (several decisions, several things only the human can supply), set each true: the picker comes back with the rest after every answer. Leave it off for alternatives, where one pick settles it.",
      "Offer only commands that can run now: no /waicc-dispatch start while one runs for the session; no /waicc-develop, /waicc-decide or new handoff while a handoff is pending (offer the step that finishes it: /waicc-continue for a reply to assess, /waicc-dispatch to send it); nothing a WAICC result just refused. WAICC swaps a blocked offer for the step that clears it.",
    ],
    parameters: Type.Object({
      commands: Type.Array(Type.Object({
        command: Type.String({ description: "The exact command line, for example /waicc-worktree list" }),
        why: Type.String({ description: "One short line: what it does for the human now" }),
      }), { minItems: 1, maxItems: 4 }),
      question: Type.Optional(Type.String({ description: "The picker's title, for example what you are stuck on" })),
      each: Type.Optional(Type.Boolean({ description: "true when every command answers its own question, so the picker returns with the rest after each answer; default true for several /waicc-decide, otherwise false" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      coordinator(ctx);
      signal?.throwIfAborted();
      const offered = params.commands.map(({ command, why }) => {
        // A command line is one line: line breaks in the agent's text become spaces, unless a command follows.
        ensure(!/[\r\n]\s*\/waicc-/.test(command), `${JSON.stringify(command.trim().slice(0, 60))} holds more than one command line; offer each as its own entry`);
        const line = command.replace(/\s+/g, " ").trim();
        const name = /^\/(\S+)/.exec(line)?.[1];
        // An amendment or a new request carries the human's own requirements: as long as the command takes.
        const max = name === "waicc-amend" || name === "waicc-planning" ? 32_000 : name && carriesText.has(name) ? 4000 : 500;
        ensure(line.length <= max, `${JSON.stringify(line.slice(0, 60))} is ${line.length} characters; a ${name ? `/${name}` : "command"} line may have at most ${max}`);
        ensure(name && commands.has(name), `${JSON.stringify(line.slice(0, 60))} is not a WAICC command.${didYouMean(name)} Only these can be offered: ${[...commands.keys()].sort().map((n) => `/${n}`).join(", ")}`);
        const args = line.slice(name.length + 1).trim();
        const fill = missingText(name, args);
        const shown = line.length > 200 ? `${line.slice(0, 200)}…` : line;
        return { line, name, args, fill, label: `${shown}${fill ? " …" : ""}  ·  ${why.replace(/\s+/g, " ").trim().slice(0, 160)}${fill ? " (you add the text)" : ""}` };
      });
      ensure(ctx.hasUI, `No picker here. Write the command${offered.length === 1 ? "" : "s"} in your reply for the human to type: ${offered.map((o) => o.line).join(", ")}`);
      offers.get(key(ctx))?.picker?.abort();
      rest.delete(key(ctx));
      const each = offered.length > 1 && (params.each ?? offered.every((o) => o.name === "waicc-decide"));
      offers.set(key(ctx), { title: params.question?.trim().slice(0, 200) || "The agent suggests running a WAICC command", offered, each });
      const unfinished = offered.filter((o) => o.fill).map((o) => o.line);
      return { content: [{ type: "text" as const, text: `Offered to the human in a picker that opens when your turn ends: ${offered.map((o) => o.line).join(", ")}.${unfinished.length ? ` ${unfinished.join(", ")} need${unfinished.length === 1 ? "s" : ""} text you did not give, so picking ${unfinished.length === 1 ? "it" : "one"} only puts it in the human's input box to finish; offer the complete command line when you know the text.` : ""}${each ? " They are separate questions: after each answer the picker comes back with the rest." : ""} End your turn now; anything the command starts for you arrives as a new message.` }], details: undefined };
    },
  });
  // The picker waits for the human only once the agent's turn is over, so a forgotten picker holds nothing up.
  pi.on("agent_end", async (_event, ctx) => openPicker(ctx));
  // After the human answered one of several questions, the rest come back once that command has run,
  // unless it started the agent (whose turn then decides what to offer) or the question was answered meanwhile.
  commandDone.push((name, ctx) => {
    const left = rest.get(key(ctx));
    if (!left || left.after !== name) return;
    rest.delete(key(ctx));
    setTimeout(() => {
      if (!ctx.isIdle() || offers.has(key(ctx))) return;
      const id = bindings.get(key(ctx))?.sessionId;
      let open: string[] | undefined;
      try {
        open = id ? decisionsView(ctx.cwd, id).decisions.filter((d) => d.status !== "resolved").map((d) => d.id.toLowerCase()) : undefined;
      } catch { /* no decisions to check against */ }
      const offered = left.offered.filter((o) => o.name !== "waicc-decide" || !open || open.includes(o.args.split(/\s/)[0].toLowerCase()));
      if (!offered.length) return;
      offers.set(key(ctx), { title: left.title, offered, each: true });
      openPicker(ctx);
    }, 0);
  });
  function openPicker(ctx: ExtensionContext) {
    const offer = offers.get(key(ctx));
    if (!offer || offer.picker) return;
    const picker = offer.picker = new AbortController();
    // A dispatch start while one runs for this session can only fail ("already running"). A loop starts
    // its next run in a later agent_end handler, so look once those have run, and again at the pick.
    const running = () => {
      const id = bindings.get(key(ctx))?.sessionId;
      return id ? dispatches.get(id) : undefined;
    };
    const startsDispatch = (o: { name: string; args: string }) => o.name === "waicc-dispatch" && !/^--(stop|progress)\b/.test(o.args);
    // A decision or new handoff refuses while a handoff is pending (its frozen inputs cannot change).
    const decides = (o: { name: string; args: string }) => ["waicc-develop", "waicc-decide"].includes(o.name)
      || (o.name === "waicc-help-develop" || o.name === "waicc-implement") && !/(^|\s)--main(\s|$)/.test(o.args);
    const pending = () => {
      const id = bindings.get(key(ctx))?.sessionId;
      try {
        return id ? loadSession(projectRoot(ctx.cwd), id).rounds.find((r) => r.status === "WAITING" || r.status === "RECEIVED") : undefined;
      } catch {
        return undefined;
      }
    };
    // What stops an offer now, and the step that clears it; null when it can run.
    const blocked = (o: { name: string; args: string }) => {
      if (startsDispatch(o)) {
        const busy = running();
        if (busy) return { why: `Already running: ${busy.label}. Nothing else was started; /waicc-dispatch --progress shows its steps.`, instead: null };
      }
      if (decides(o)) {
        const r = pending();
        if (r) return r.status === "RECEIVED"
          ? { why: `A ${r.mode} reply is waiting to be assessed, so ${o.name.replace("waicc-", "/waicc-")} cannot run yet. /waicc-continue first, then pick it again.`, instead: { line: "/waicc-continue", name: "waicc-continue", args: "", fill: false, label: `/waicc-continue  ·  assess the waiting ${r.mode} reply first; then the decision can be made` } }
          : running()
            // Its agent is working: the reply comes back by itself; nothing to pick until then.
            ? { why: `A ${r.mode} handoff is being worked on (${running()!.label}), so ${o.name.replace("waicc-", "/waicc-")} cannot run until its reply is assessed.`, instead: null }
            : { why: `A ${r.mode} handoff is still waiting for its reply, so ${o.name.replace("waicc-", "/waicc-")} cannot run yet. Send it (/waicc-dispatch) or drop it (/waicc-cancel) first.`, instead: { line: "/waicc-dispatch", name: "waicc-dispatch", args: "", fill: false, label: `/waicc-dispatch  ·  send the waiting ${r.mode} handoff first; the decision comes after its reply` } };
      }
      return null;
    };
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      // A blocked offer gives way to the step that clears it, once; a dispatch start while one runs just goes.
      const choices: typeof offer.offered = [], reasons: string[] = [];
      for (const o of offer.offered) {
        const stop = blocked(o);
        if (stop) reasons.push(stop.why);
        const next = stop ? stop.instead : o;
        if (next && !choices.some((c) => c.line === next.line)) choices.push(next);
      }
      if (!choices.length || picker.signal.aborted) {
        if (offers.get(key(ctx)) === offer) offers.delete(key(ctx));
        // Nothing left to pick: say why instead of showing nothing.
        if (!picker.signal.aborted && reasons.length) ctx.ui.notify(reasons[0], "info");
        return;
      }
      const picked = await ctx.ui.select(offer.title, [...choices.map((o) => o.label), "None of these"], { signal: picker.signal });
      if (offers.get(key(ctx)) === offer) offers.delete(key(ctx));
      const chosen = picker.signal.aborted ? undefined : choices.find((o) => o.label === picked);
      // Things may have moved while the picker was open.
      const late = chosen ? blocked(chosen) : null;
      if (late) return ctx.ui.notify(late.why, "info");
      // Several questions: the others come back after this answer.
      const others = chosen && offer.each ? choices.filter((o) => o !== chosen) : [];
      if (others.length) rest.set(key(ctx), { title: offer.title, offered: others, each: true, after: chosen!.name });
      // Run without its text it could only fail: the human finishes it instead.
      if (chosen?.fill) {
        ctx.ui.setEditorText(`${chosen.line} `);
        return ctx.ui.notify(`${chosen.line} needs your text: finish it in the input box, then press Enter.`, "info");
      }
      // The human's pick runs it once, as typed; the input box is left alone, so a second Enter does nothing.
      // No WAICC command uses the command-only parts of the context (new session, fork, wait for idle).
      if (chosen) await commands.get(chosen.name)!(chosen.args, ctx as unknown as ExtensionCommandContext);
    })().catch((error) => logged(ctx, "picker").ui.notify(error instanceof Error ? error.message : String(error), "error"));
  }
  // A new turn may offer something else; an offer from an ended chat is gone with it.
  const withdraw = (ctx: Parameters<typeof key>[0]) => {
    offers.get(key(ctx))?.picker?.abort();
    offers.delete(key(ctx));
    rest.delete(key(ctx));
  };
  pi.on("agent_start", async (_event, ctx) => withdraw(ctx));
  pi.on("session_shutdown", async (_event, ctx) => withdraw(ctx));
}
