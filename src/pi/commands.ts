import { assertRecipientCurrent, assignmentText, receiveHandoff } from "../recipient.ts";
import { initialize, json, loadSession } from "../files.ts";
import { decisionSettings } from "../profiles.ts";
import { openPage, publish, setTrackerEnabled, trackerEnabled, trackerPage } from "../tracker.ts";
import { autoDecidable } from "../decisions.ts";
import { checkpointView, frozenCheckpointView, refreshCheckpoint } from "../checkpoint.ts";
import { deleteSession, restoreSession } from "../lifecycle.ts";
import { initProject, projectRoot } from "../source.ts";
import { manualHandoffMessage } from "../render.ts";
import type { manualHandoff } from "../render.ts";
import { beginDevelopment, decisionsView, openDecisionsText, resolveDecision, readContract, createSession, createRevisionReview, refreshRevisionReview, delegateWork, issue, status, saveContext, useMainWork } from "../workflow.ts";
import { advisorInput, ensure } from "../validation.ts";
import type { SessionListFilter } from "../workflow.ts";
import type { Contract } from "../types.ts";
import { autoPlanningMode } from "../auto-planning.ts";
import { recipientResponsibilities } from "../instructions.ts";
import { type ChatBinding, recipientGuidance, sessionCommandInput, developInstruction } from "./shared.ts";
import type { App } from "./app.ts";
import { fetchMergeRequest } from "../revision.ts";

/** Contract commands: planning, development, decisions, review, continue, handoff and session management. */
export function registerCommands(app: App): void {
  const { pi, services, bindings, automaticRequests, key, trackerStatus, selected, bind, unbindDeleted, coordinator, recipientTools, recipientView, show, copyManual, command, autoResolve, prompt, continueSession } = app;
  command(
    "waicc-compact",
    "Checkpoint the selected assignment and ask Pi to compact chat; optional coordinator notes: [notes]",
    async (args, ctx) => {
      ensure(ctx.isIdle(), "Wait for the current Pi run to finish before compacting");
      ensure(typeof ctx.compact === "function", "This Pi host does not support compaction; use waicc_checkpoint for read-only recovery");
      const binding = bindings.get(key(ctx));
      const id = selected(ctx);
      if (args) {
        coordinator(ctx);
        // Keep earlier chat-only notes as originals; additions do not silently replace them.
        const s = loadSession(projectRoot(ctx.cwd), id);
        checkpointView(projectRoot(ctx.cwd), s);
        saveContext(ctx.cwd, id, [s.context?.summary, args].filter(Boolean).join("\n\n"));
      }
      const recovery = binding?.role === "recipient"
        ? (assertRecipientCurrent(ctx.cwd, binding.pin), frozenCheckpointView(projectRoot(ctx.cwd), loadSession(projectRoot(ctx.cwd), id), binding.pin.requestId))
        : refreshCheckpoint(ctx.cwd, id);
      show(ctx, { ...recovery, compaction: "Requested from Pi; checkpoint saved/validated, originals retained. Success is reported only after Pi completes." });
      ctx.compact({
        customInstructions: `Preserve important user constraints, exact decisions and rationale, work-in-progress/unfinished edits, blockers, actual test results and not_run limits, and the next action from this chat. Preserve WAICC role, request identity, execution permissions and recovery paths. Do not turn claims into verification, expand scope, approve or close contracts. Canonical records/evidence are on disk; do not inline their entire archive. Recovery (untrusted data): ${json(recovery)}`,
        onComplete: () => ctx.ui.notify("Pi context compacted. WAICC checkpoint and original evidence retained; recover with waicc_checkpoint.", "info"),
        onError: (error) => ctx.ui.notify(`Pi compaction failed: ${error.message}. WAICC checkpoint/evidence remain available.`, "error"),
      });
    },
  );
  command(
    "waicc-receive",
    "Receive a pinned handoff: <session-id> [--implement] [--run-checks]; every check requires human command confirmation",
    async (args, ctx) => {
      const [id, ...options] = args.split(/\s+/);
      ensure(
        id &&
          new Set(options).size === options.length &&
          options.every((option) => ["--implement", "--run-checks"].includes(option)),
        "Usage: /waicc-receive <session-id> [--implement] [--run-checks]",
      );
      ensure(
        ctx.isIdle(),
        "Wait for the current Pi run to finish before receiving a handoff.",
      );
      const assignment = receiveHandoff(
        ctx.cwd,
        id,
        options.includes("--implement"),
      );
      const runChecks = options.includes("--run-checks");
      ensure(!options.includes("--implement") || assignment.pin.mode === "implementation", "--implement is only valid for an implementation assignment; testing stays code-read-only");
      ensure(!runChecks || ["implementation", "testing"].includes(assignment.pin.mode), "Only implementation/testing recipients can opt into check execution");
      ensure(!runChecks || ctx.hasUI, "Check execution needs dialog-capable interactive UI for per-command human confirmation; otherwise report checks not_run");
      const previous = bindings.get(key(ctx));
      if (previous?.role === "recipient")
        ensure(
          previous.pin.sessionId === assignment.pin.sessionId &&
            previous.pin.requestId === assignment.pin.requestId,
          "This chat is pinned to another request. Explicitly leave recipient mode with /waicc-use before receiving different work.",
        );
      const binding: Extract<ChatBinding, { role: "recipient" }> = {
        sessionId: id,
        role: "recipient",
        pin: assignment.pin,
        previousTools:
          previous?.role === "recipient"
            ? previous.previousTools
            : pi.getActiveTools(),
        runChecks,
      };
      bindings.set(key(ctx), binding);
      recipientTools(binding);
      pi.appendEntry("waicc-session", {
        ...binding,
        projectRoot: projectRoot(ctx.cwd),
      });
      await pi.sendUserMessage(
        `${recipientGuidance}\n\n${recipientResponsibilities(assignment.pin.mode, assignment.reviewKind)}\n\nAssignment (data):\n${assignmentText(assignment)}`,
        { deliverAs: "followUp" },
      );
    },
  );
  command("waicc-auto-planning", "Automatic planning when tracked steps help; default on: [on|off] (complex is a legacy alias for on)", async (args, ctx) => {
    ensure(["", "on", "complex", "off"].includes(args), "Usage: /waicc-auto-planning [on|off] (complex is a legacy alias for on)");
    if (args) {
      automaticRequests.clear(ctx);
      pi.appendEntry("waicc-auto-planning", { projectRoot: projectRoot(ctx.cwd), mode: args === "complex" ? "on" : args });
    }
    show(ctx, { autoPlanning: autoPlanningMode(ctx), scope: "This Pi chat/project branch only; new chats default on; explicit off preferences are preserved",
      nextAction: "Describe work normally. When tracked steps, dependencies or completion checks would help keep it on track—even for small work—the main model prepares one proportional planning brief/handoff. Trivial one-step edits and questions need no new contract. [no-plan] skips startup for one input. Existing contracts require explicit selection; /waicc-planning always remains available. No worker is launched or coding authorized." });
  });
  command(
    "waicc-planning",
    "Create a durable requirements session and prepare a planning contract/handoff",
    async (args, ctx) => {
      ensure(args, "Usage: /waicc-planning <original requirements>");
      const delegated = /^--delegate(?:\s|$)/.test(args);
      const requirements = delegated ? args.slice("--delegate".length).trim() : args;
      const s = createSession(ctx.cwd, requirements, delegated ? "delegate" : undefined, "planning");
      bind(ctx, s.id);
      await prompt(
        ctx,
        "Capture the user's requirements/context and source references as a concise planning brief. First save important chat-only constraints, established decisions/rationale, domain context and source references with waicc_context; summaries do not change scope. Then use waicc_prepare. A draft may use tasks: [] rather than inventing a detailed plan. The planner investigates source and returns proposedContract; do not implement while planning. Honor implementationOwner: delegate means the main agent coordinates and generates ONE full implementation handoff after plan adoption, not application edits itself.",
      );
    },
  );
  command("waicc-develop", "Accept the current plan and explicitly authorize development in this session: [--main|--delegate]", async (args, ctx) => {
    ensure(["", "--main", "--delegate"].includes(args), "Usage: /waicc-develop [--main|--delegate]");
    const id = selected(ctx);
    beginDevelopment(ctx.cwd, id, args === "--main" ? "main" : args === "--delegate" ? "delegate" : undefined);
    autoResolve(ctx, id);
    await prompt(ctx, developInstruction);
  });
  command("waicc-init", "Make the current folder its own WAICC project, for example one service in a monorepo", async (_args, ctx) => {
    // From now on this chat resolves to the new project; its old selection stays with the old one.
    show(ctx, initProject(ctx.cwd, initialize));
  });
  command("waicc-decisions", "Show a consolidated decision brief, recommendations and affected tasks: [session-id]", async (args, ctx) => {
    ensure(!args || !/\s/.test(args), "Usage: /waicc-decisions [session-id]");
    show(ctx, decisionsView(ctx.cwd, selected(ctx, args || undefined)));
  });
  command("waicc-decide", "Record your answer to a decision gate: <decision-id> <answer>, <decision-id> recommended, all recommended, auto (your low-risk setting), or no arguments to pick one; not a scope amendment", async (args, ctx) => {
    const id = selected(ctx);
    const view = decisionsView(ctx.cwd, id);
    const open = view.decisions.filter((decision) => decision.status !== "resolved");
    const listed = openDecisionsText({ decisions: view.decisions } as Contract);
    ensure(open.length, listed);
    // "recommended" accepts the agent's recommendation as your answer.
    const recommended = (text: string) => /^(recommended|recommendation|rec)$/i.test(text.trim());
    const record = (decision: (typeof open)[number], answer: string) => resolveDecision(ctx.cwd, id, decision.id, answer);
    const done = () => show(ctx, { ...decisionsView(ctx.cwd, id), session: status(ctx.cwd, id) });
    if (args.toLowerCase() === "auto") {
      const enabled = decisionSettings(ctx.cwd).autoDecide === "low-risk";
      const accepted = enabled ? autoResolve(ctx, id) : [];
      const left = (readContract(ctx.cwd, id).contract.decisions ?? []).filter((d) => d.status !== "resolved");
      show(ctx, {
        autoDecide: enabled ? "low-risk" : "off",
        accepted,
        stillYours: left.map((d) => ({ id: d.id, question: d.question, why: enabled ? autoDecidable(d).reason : "autoDecide is off" })),
        nextAction: enabled
          ? left.length ? "Answer the rest with /waicc-decide (or <ID> recommended)." : "No open decisions are left."
          : 'Set "autoDecide": "low-risk" in your user agent config to accept qualifying recommendations automatically.',
      });
      return;
    }
    const word = /^(\S+)\s*([\s\S]*)$/.exec(args);
    if (word && word[1].toLowerCase() === "all") {
      ensure(recommended(word[2]), "Usage: /waicc-decide all recommended (accept every open decision's recommendation)");
      if (ctx.hasUI)
        ensure(await ctx.ui.confirm(`Accept the recommendation for all ${open.length} open decision${open.length === 1 ? "" : "s"}?`,
          open.map((d) => `${d.id}: ${d.question}\n  → ${d.recommendation}`).join("\n\n")), "Nothing recorded.");
      for (const decision of open) record(decision, decision.recommendation);
      return done();
    }
    let decision = word ? open.find((d) => d.id.toLowerCase() === word[1].toLowerCase()) : undefined;
    let answer = decision ? word![2].trim() : "";
    if (!decision && args) {
      // An answer typed without its ID: with one open decision, confirm it is meant for that one.
      ensure(open.length === 1 && ctx.hasUI, `${JSON.stringify(word![1])} is not an open decision ID. ${listed}`);
      const text = recommended(args) ? open[0].recommendation : args;
      ensure(await ctx.ui.confirm(`Record this as the answer to ${open[0].id}?`, `${open[0].question}\n\nAnswer: ${text}`), "Nothing recorded.");
      [decision, answer] = [open[0], text];
    }
    if (!decision) {
      ensure(ctx.hasUI, `Usage: /waicc-decide <decision-id> <answer>, or <decision-id> recommended. ${listed}`);
      const labels = open.map((d) => `${d.id} (${d.owner}): ${d.question}`);
      const picked = await ctx.ui.select("Which decision are you answering?", labels);
      ensure(picked, "Nothing recorded.");
      decision = open[labels.indexOf(picked)];
    }
    if (recommended(answer)) {
      // Typed explicitly; show what that means when a dialog is available.
      if (ctx.hasUI)
        ensure(await ctx.ui.confirm(`Accept the recommendation for ${decision.id}?`, `${decision.question}\n\n→ ${decision.recommendation}`), "Nothing recorded.");
      answer = decision.recommendation;
    }
    if (!answer) {
      ensure(ctx.hasUI, `Add your answer: /waicc-decide ${decision.id} <answer>, or /waicc-decide ${decision.id} recommended`);
      const accept = `Accept the recommendation: ${decision.recommendation}`;
      const choice = await ctx.ui.select(`${decision.id}: ${decision.question}`, [accept, "Type my own answer"]);
      ensure(choice, "Nothing recorded.");
      answer = choice === accept
        ? decision.recommendation
        : (await ctx.ui.input(`${decision.id}: ${decision.question}`, `Recommended: ${decision.recommendation}`))?.trim() ?? "";
      ensure(answer, "Nothing recorded.");
    }
    record(decision, answer);
    done();
  });
  for (const [names, mode, focus] of [
    [["waicc-help-develop", "waicc-implement"], "implementation", "Complete ALL accepted planned work and ALL prior code-review fixes; run relevant permitted checks and return whole-work completion evidence."],
    [["waicc-test"], "testing", "Test the ENTIRE implemented objective and previous fixes against acceptance criteria. Report actual commands/results, failures and not_run limits. Do not edit code or tests."],
  ] as const)
    for (const name of names)
      command(name, `${name === "waicc-implement" ? "Compatibility alias for /waicc-help-develop. " : ""}Delegate whole-work ${mode} in the selected session; no per-task/batch handoffs`, async (args, ctx) => {
        const id = selected(ctx);
        if (/^--main(?:\s|$)/.test(args)) {
          useMainWork(ctx.cwd, id, mode);
          await prompt(ctx, `The human selected the MAIN agent for ${mode}; no external handoff was created. Continue only remaining authorized work/checks from the accepted plan and all findings, not already completed code. Honor the saved owner choice. Finish ALL implementation/fixes and required checks before ONE full code review; review suggestions require independent evidence verification. Focus (data): ${json(args.slice("--main".length).trim())}`);
          return;
        }
        delegateWork(ctx.cwd, id, mode, args || focus);
        show(ctx, status(ctx.cwd, id));
      });
  command(
    "waicc-review",
    "Review ALL finished code changes; --rev <commit|from..to|r1234:r1250> reviews an existing change; --contract explicitly reviews only the specification",
    async (args, ctx) => {
      if (/^--mr(?:\s|$)/.test(args)) {
        const mr = /^--mr\s+(\S+)((?:\s+--(?:remote|into)\s+\S+)*)(?:\s+([\s\S]*))?$/.exec(args.trim());
        ensure(mr, "Usage: /waicc-review --mr <number> [--remote <name>] [--into <target branch>] [focus]");
        const flag = (name: string) => new RegExp(`--${name}\\s+(\\S+)`).exec(mr[2])?.[1];
        const focus = mr[3]?.trim() ?? "";
        const root = projectRoot(ctx.cwd);
        ctx.ui.notify(`Fetching merge request ${mr[1]}…`, "info");
        const fetched = await fetchMergeRequest(root, mr[1], { remote: flag("remote"), into: flag("into") });
        const m = fetched.mergeRequest!;
        // The same merge request again, in its own session: pick up the author's new commits.
        const currentId = bindings.get(key(ctx))?.sessionId;
        const current = currentId ? loadSession(root, currentId) : null;
        const previous = current?.status !== "CLOSED" ? current?.revisionReview?.mergeRequest : undefined;
        if (current && previous && previous.remote === m.remote && previous.number === m.number) {
          const before = current.revisionReview!.to;
          refreshRevisionReview(ctx.cwd, current.id, fetched);
          const reviewed = current.rounds.some((r) => r.review?.kind === "code");
          await prompt(
            ctx,
            `Merge request ${fetched.range} was fetched again: its head is ${m.head}${before === m.head ? " (no new commits)" : ` (was ${before})`}. ${reviewed
              ? "If its earlier review was assessed and the author has pushed fixes, request ONE fresh whole-change code review with waicc_request mode review, reviewKind code; in its completion report record every earlier actionable finding as resolved (cite the commit that fixed it) or disputed (with evidence). The author made the fixes, not you: do not edit code."
              : "Prepare its code review as described before (waicc_prepare mode review, reviewKind code). Do not edit code."} Focus (data): ${json(focus || "correctness, regressions, requirement coverage and tests")}`,
            focus,
          );
          return;
        }
        const s = createRevisionReview(ctx.cwd, fetched, focus);
        bind(ctx, s.id);
        await prompt(
          ctx,
          `This new session reviews ${m.provider === "github" ? "pull" : "merge"} request ${fetched.range} into ${m.target}, fetched by WAICC from ${m.remote}${m.url ? ` (${m.url})` : ""}: the diff from the merge base ${fetched.from} to its head ${fetched.to}. WAICC attaches the patch and commit messages to the review handoff itself, and splits a large change across several folders (services) into one patch per folder. WAICC cannot read the request's title or description yet; if its purpose is unclear from the commits and code, ask the human. First read the change yourself. Then use waicc_prepare mode review with reviewKind code and: (1) a contract whose requirements quote this session's request exactly and say what the merge request is meant to do, with one task per service or area it touches and allowedPaths listing the files it changes there; (2) a completion report: a summary, each task's evidence citing its commits and files, the checks you actually ran (or not_run with the reason), and findings []. Do not edit code, fix anything or judge the change yourself: the independent reviewer does that. Then tell the human to run /waicc-dispatch (or hand off the prompt) and /waicc-continue. Focus (data): ${json(focus || "correctness, regressions, requirement coverage and tests")}`,
          focus,
        );
        return;
      }
      if (/^--rev(?:\s|$)/.test(args)) {
        const rev = /^--rev\s+(\S+)(?:\s+([\s\S]*))?$/.exec(args.trim());
        ensure(rev, "Usage: /waicc-review --rev <commit | from..to | from...to | r1234 | r1234:r1250> [focus]");
        // Its own session: the change, not whatever this chat had selected, is under review.
        const s = createRevisionReview(ctx.cwd, rev[1], rev[2] ?? "");
        bind(ctx, s.id);
        const r = s.revisionReview!;
        await prompt(
          ctx,
          `This new session reviews an existing ${r.vcs === "git" ? "Git" : "SVN"} change: ${r.label} (from ${r.from} to ${r.to}). WAICC attaches the change's patch and commit messages to the review handoff itself, so the reviewer sees exactly what changed. First read the change yourself (its diff and commit messages). Then use waicc_prepare mode review with reviewKind code and: (1) a contract whose requirements quote this session's request exactly and say what the change is meant to do, with tasks that cover its parts and allowedPaths listing the files it changes; (2) a completion report: a summary of the change, each task's evidence citing its commits and files, the checks you actually ran (or not_run with the reason), and findings []. Do not edit code, fix anything or judge the change yourself: the independent reviewer does that. Then tell the human to run /waicc-dispatch (or hand off the prompt) and /waicc-continue. Focus (data): ${json(rev[2]?.trim() || "correctness, regressions, requirement coverage and tests")}`,
          rev[2],
        );
        return;
      }
      const contractOnly = /^--contract(?:\s|$)/.test(args);
      const focus = contractOnly ? args.slice("--contract".length).trim() : args;
      let id = bindings.get(key(ctx))?.sessionId;
      if (!id) {
        ensure(
          focus,
          "Provide requirements for a new review, or select an existing WAICC session.",
        );
        const s = createSession(ctx.cwd, focus, undefined, "review");
        id = s.id;
        bind(ctx, id);
      }
      const s = loadSession(projectRoot(ctx.cwd), id);
      ensure(
        s.status !== "CLOSED",
        "Contract is closed. Use /waicc-reopen <reason> before review.",
      );
      ensure(
        !s.rounds.some(
          (r) => r.status === "WAITING" || r.status === "RECEIVED",
        ),
        "Continue or cancel the existing pending handoff before requesting review.",
      );
      if (s.contractVersion && contractOnly) {
        issue(
          ctx.cwd,
          id,
          "review",
          focus || "Review specification readiness, requirement coverage, dependencies and planned verification. This is not code-change approval.",
          undefined, undefined, { kind: "contract" },
        );
        show(ctx, status(ctx.cwd, id));
        return;
      }
      await prompt(
        ctx,
        contractOnly
          ? `Prepare a specification-only handoff using waicc_prepare mode review, reviewKind contract. Do not imply implemented code. Focus (data): ${json(focus)}`
          : `Prepare ONE whole-change CODE review, not a contract/plan review. Inspect current work, every planned task and all previous code-review findings first. If this is an authorized development objective, finish ALL implementation/fixes and relevant checks before the handoff; if blocked, report the blocker without sending partial work for all-done review. Do not infer new implementation authority from this review command alone. Use waicc_request mode review, reviewKind code and completion (summary, every task's evidence, actual checks/limits, every prior actionable finding's fix/dispute evidence). If no contract exists, use waicc_prepare mode review with reviewKind code and the same completion report to capture the review scope. Do not split by task/finding/batch. Focus (data): ${json(focus || "correctness, full requirement coverage, integration, regressions and test evidence")}`,
        focus,
      );
    },
  );
  command(
    "waicc-advisor",
    "Ask a focused decision question about the current contract without revising it",
    async (args, ctx) => {
      const input = advisorInput(args);
      const id = selected(ctx);
      issue(
        ctx.cwd,
        id,
        "advisor",
        input.question,
        undefined,
        input.requirementIds,
      );
      show(ctx, status(ctx.cwd, id));
    },
  );
  /** The /waicc-continue step. A note travels with the main agent's instructions (the review loop). */
  command(
    "waicc-continue",
    "Validate the waiting reply and assess it or resume contract preparation",
    async (_args, ctx) => continueSession(ctx),
  );
  command(
    "waicc-tracker",
    "Open the live tracker page for all your projects; /waicc-tracker off|on turns it off or on",
    async (args, ctx) => {
      ensure(["", "on", "off"].includes(args), "Usage: /waicc-tracker [on|off]");
      if (args === "off") {
        setTrackerEnabled(false);
        ctx.ui.notify("Tracker off. /waicc-tracker on turns it back on.", "info");
        show(ctx, { tracker: "off", page: trackerPage(), nextAction: "No Pi chat updates the page now. /waicc-tracker on turns it back on." });
        return;
      }
      if (args === "on") setTrackerEnabled(true);
      ensure(trackerEnabled(), process.env.WAICC_TRACKER === "off"
        ? "The tracker is turned off for this Pi by WAICC_TRACKER=off."
        : "The tracker is off. /waicc-tracker on turns it back on.");
      const page = publish(trackerStatus(ctx, projectRoot(ctx.cwd)));
      const opened = ctx.hasUI && (services.openPage ?? openPage)(page);
      show(ctx, {
        tracker: "on", page, opened,
        nextAction: `${opened ? "Opened in your browser." : `Open ${page} in your browser.`} It refreshes itself every 3 s and shows every project where Pi runs WAICC; keep it open. Nothing leaves your computer.`,
      });
    },
  );
  command(
    "waicc-status",
    "Show selected session progress; open/all/closed/deleted explicitly lists project sessions",
    async (args, ctx) => {
      const binding = bindings.get(key(ctx));
      if (
        binding?.role === "recipient" &&
        (!args || args === binding.sessionId)
      ) {
        show(ctx, recipientView(ctx, binding));
        return;
      }
      const listing = ["open", "all", "closed", "deleted"].includes(args);
      show(
        ctx,
        listing
          ? status(ctx.cwd, undefined, args as SessionListFilter)
          : status(ctx.cwd, args || binding?.sessionId),
      );
    },
  );
  command(
    "waicc-list",
    "List open sessions by default; all includes CLOSED, closed shows only CLOSED, deleted lists recovery storage",
    async (args, ctx) => {
      ensure(
        ["", "open", "all", "closed", "deleted"].includes(args),
        "Usage: /waicc-list [open|all|closed|deleted]",
      );
      show(ctx, status(ctx.cwd, undefined, (args || "open") as SessionListFilter));
    },
  );
  command(
    "waicc-delete",
    "Remove one CLOSED session to recovery storage: <session-id> (human action)",
    async (args, ctx) => {
      const input = sessionCommandInput(args);
      ensure(input.id && !input.remainder, "Usage: /waicc-delete <session-id>");
      const deleted = deleteSession(ctx.cwd, input.id);
      unbindDeleted(ctx, input.id);
      show(ctx, deleted);
    },
  );
  command(
    "waicc-restore",
    "Restore one deleted session, still CLOSED: <session-id> (human action)",
    async (args, ctx) => {
      const input = sessionCommandInput(args);
      ensure(input.id && !input.remainder, "Usage: /waicc-restore <session-id>");
      show(ctx, restoreSession(ctx.cwd, input.id));
    },
  );
  command(
    "waicc-handoff",
    "Show exactly what to copy to a manual recipient and what to run after its reply: [session-id]",
    async (args, ctx) => {
      ensure(!args || !/\s/.test(args), "Usage: /waicc-handoff [session-id]");
      const view = status(ctx.cwd, selected(ctx, args || undefined)) as {
        manualHandoff: ReturnType<typeof manualHandoff> | null;
      };
      ensure(
        view.manualHandoff,
        "No unanswered waiting handoff. Use /waicc-status; if reply.json already exists, /waicc-continue in the coordinator instead.",
      );
      const clipboard = await copyManual(ctx, view.manualHandoff, true);
      pi.sendMessage(
        {
          customType: "waicc-manual-handoff",
          content: `${clipboard?.message ?? ""}\n\n${manualHandoffMessage(view.manualHandoff)}`,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  );
}
