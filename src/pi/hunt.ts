import { consultSettings } from "../profiles.ts";
import { reportBugsSpec, type ReportBugsParams } from "../tool-specs.ts";
import { piTool } from "./shared.ts";
import { huntLimit, huntRequirements, huntTable, listHunts, markPicked, pickBugs, pickSplitAt, reportBugs, startHunt, triageBugs } from "../hunt.ts";
import { elapsed } from "../progress.ts";
import { createSession } from "../workflow.ts";
import { ensure } from "../validation.ts";
import type { App } from "./app.ts";

/** /waicc-bug-hunt: the main agent scans read-only, the advisor triages, and you pick what gets planned. */
export function registerHuntCommands(app: App): void {
  const { pi, services, command, registerTool, trusted, coordinator, notice, bind, prompt } = app;
  command("waicc-bug-hunt", "Have the main agent read a scope in detail and list possible bugs, checked by your advisor before any fix is planned: <scope>", async (args, ctx) => {
    const hunt = startHunt(ctx.cwd, args);
    pi.sendUserMessage(
      `Bug hunt ${hunt.id} over (data): ${JSON.stringify(hunt.scope)}\n\nRead the code in that scope in detail, and what it calls where that matters, to find real defects: wrong results, crashes, unhandled errors or edge cases, races, resource leaks, security holes, and behaviour that contradicts its own docs or tests. Skip style, naming and refactoring wishes.\n\nThis is a read-only scan. Do not edit, create, delete or format any file, and run nothing that changes files (no fixes, formatters, code generators, dependency installs or tests that write snapshots). WAICC refuses the report if the source changed during the hunt.\n\nFor each candidate, name the file and line, the exact input or state that triggers it, what goes wrong, and a severity (high, medium or low). Report at most ${huntLimit}, most severe first; leave out anything you cannot tie to a concrete trigger. Then call waicc_report_bugs once with huntId ${hunt.id}; an empty list means you found none. Your advisor checks the list after that, and the human picks what to fix: do not start fixing or planning.`,
      { deliverAs: "followUp" },
    );
    ctx.ui.notify(`Bug hunt started over ${hunt.scope}. The main agent reads it read-only, then your advisor checks what it finds.`, "info");
  });
  registerTool(piTool<ReportBugsParams>(reportBugsSpec, {
    async execute(_id, params, signal, update, ctx) {
      trusted(ctx);
      coordinator(ctx);
      signal?.throwIfAborted();
      reportBugs(ctx.cwd, params.huntId, params.bugs);
      // The human asked for this check, so it uses the advisor role even when asking it on its own is off.
      const settings = consultSettings(ctx.cwd);
      const advisor = settings.profile && settings.options ? { profile: settings.profile, options: settings.options } : null;
      if (advisor && params.bugs.length) ctx.ui.notify(`Your advisor (${advisor.profile}) is checking ${params.bugs.length} candidate bug${params.bugs.length > 1 ? "s" : ""}…`, "info");
      const hunt = await triageBugs(ctx.cwd, params.huntId, advisor, services.runAgent, signal, (event) =>
        update?.({ content: [{ type: "text", text: `Advisor: ${event.text}` }], details: undefined }));
      if (advisor && hunt.bugs.length)
        notice(ctx, hunt.triage?.answer ? "info" : "warning", `Advisor ${advisor.profile} ${hunt.triage?.answer ? "checked" : "could not check"} the bug hunt's ${hunt.bugs.length} candidates in ${elapsed(hunt.triage?.durationMs ?? 0)}.`);
      return {
        content: [{
          type: "text" as const,
          text: `${huntTable(hunt)}\n\nShow this table to the human as it is and stop. Do not start fixing or planning: the human picks with /waicc-bug-pick, and the picked bugs become a planning session.`,
        }],
        details: undefined,
      };
    },
  }));
  command("waicc-bug-pick", `Plan fixes for bugs from the last bug hunt: all (confirmed), all+plausible, or IDs such as B1 B3; above ${pickSplitAt}, splitting is suggested`, async (args, ctx) => {
    const hunt = listHunts(ctx.cwd).find((h) => h.status === "TRIAGED");
    ensure(hunt, listHunts(ctx.cwd).some((h) => h.status === "SCANNING")
      ? "The bug hunt has not been reported yet: wait for the main agent's waicc_report_bugs and the advisor's check."
      : "No bug hunt is waiting to be picked from. Start one with /waicc-bug-hunt <scope>.");
    const bugs = pickBugs(hunt, args);
    if (bugs.length > pickSplitAt && ctx.hasUI && !(await ctx.ui.confirm(`Plan all ${bugs.length} bugs in one session?`,
      `More than ${pickSplitAt} bugs make one contract large: review rounds get long and a session allows at most 20 rounds. Consider splitting by severity or area, for example /waicc-bug-pick ${bugs.filter((b) => b.severity === "high").map((b) => b.id).join(" ") || bugs.slice(0, pickSplitAt).map((b) => b.id).join(" ")} now and the rest later.\n\nYes plans all ${bugs.length} in one session; No changes nothing.`)))
      return ctx.ui.notify("Nothing was started. Pick fewer bugs with /waicc-bug-pick <IDs>.", "info");
    const s = createSession(ctx.cwd, huntRequirements(hunt, bugs), undefined, "planning");
    markPicked(ctx.cwd, hunt.id, s.id);
    bind(ctx, s.id);
    await prompt(
      ctx,
      `The human picked ${bugs.map((b) => b.id).join(", ")} from a bug hunt; they are this session's requirements. Use waicc_prepare for a planning contract with one requirement per bug, each naming its failing test or repro as the completion check. Verify each bug against the source while planning; if one turns out not to be a bug, say so in the contract rather than inventing a fix. Do not implement while planning.`,
    );
  });
}

