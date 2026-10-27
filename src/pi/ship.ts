import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadAgentConfig } from "../profiles.ts";
import { planShip, requestOpener, ship, type ShipOptions, type ShipPlan } from "../ship.ts";
import { closeShipped } from "../workflow.ts";
import { ensure } from "../validation.ts";
import { json } from "../files.ts";
import type { Shipped } from "../types.ts";
import { resolveGitlabHost } from "./merge-requests.ts";
import type { App, Core } from "./app.ts";

const list = (items: string[], max = 12) => [...items.slice(0, max).map((item) => `  ${item}`), ...(items.length > max ? [`  … and ${items.length - max} more`] : [])].join("\n");

/** What the human confirms: every file, the branch, the remote, and what else goes out with it. */
export function shipSummary(plan: ShipPlan): string {
  return [
    `${plan.newBranch ? "New branch" : "Branch"} ${plan.branch} → merge request into ${plan.target}, pushed to ${plan.remote}${plan.remoteUrl ? ` (${plan.remoteUrl})` : ""}.`,
    plan.files.length ? `Commit ${plan.files.length} reviewed file${plan.files.length === 1 ? "" : "s"}:\n${list(plan.files)}` : "No new commit: the reviewed files are already committed.",
    plan.earlierCommits.length ? `Also goes out: ${plan.earlierCommits.length} earlier commit${plan.earlierCommits.length === 1 ? "" : "s"} on this branch that ${plan.target} lacks:\n${list(plan.earlierCommits, 6)}` : "",
    plan.leftOut.length ? `Not included (not part of the reviewed change; left as they are):\n${list(plan.leftOut, 6)}` : "",
    plan.previous ? `Shipped before as ${plan.previous.request.url ?? plan.previous.branch}: this push updates it.` : "",
    "Everyone with access to the remote will see the branch and the merge request. The session is closed afterwards.",
  ].filter(Boolean).join("\n\n");
}

/**
 * /waicc-ship, and the end of a --ship run: plan, confirm, commit, push, open the merge request,
 * close. A --ship run skips the confirmation only with "autoShip": true in your user file.
 * Returns what went out, or null when you said no.
 */
export async function shipSession(app: Core, ctx: ExtensionCommandContext, id: string, options: ShipOptions, automatic = false): Promise<Shipped | null> {
  const { pi, notice } = app;
  const plan = planShip(ctx.cwd, id, options);
  const unasked = automatic && loadAgentConfig(ctx.cwd).autoShip;
  if (!unasked) {
    ensure(ctx.hasUI, automatic
      ? `The review passed, but shipping needs your yes in Pi's interactive screen (or "autoShip": true in your user file). Run /waicc-ship.`
      : "Shipping needs your confirmation in Pi's interactive screen. The CLI ships with: waicc ship <session-id> --yes");
    if (!(await ctx.ui.confirm(automatic ? "The review passed. Ship it?" : "Ship this change?", shipSummary(plan)))) {
      ctx.ui.notify("Nothing was committed or pushed. /waicc-ship when you are ready.", "info");
      return null;
    }
  }
  ctx.ui.notify(`Shipping: committing to ${plan.branch} and pushing to ${plan.remote}…`, "info");
  const { services } = app;
  const shipped = await ship(plan, await requestOpener(plan, {
    host: (name) => resolveGitlabHost(ctx.cwd, name), gitlab: services.gitlab, origin: services.gitlabOrigin, github: services.github,
  }));
  closeShipped(ctx.cwd, id, shipped);
  const where = shipped.request.url ? `${shipped.request.how === "existing" ? "Updated" : "Opened"} ${shipped.request.url}` : `Pushed ${shipped.branch}`;
  const message = `Shipped: ${where} (${shipped.files.length} file${shipped.files.length === 1 ? "" : "s"}, commit ${shipped.commit.slice(0, 10)} on ${shipped.branch} → ${shipped.target}). The session is closed.${shipped.request.note ? ` ${shipped.request.note}` : ""}`;
  notice(ctx, shipped.request.url ? "info" : "warning", message);
  ctx.ui.notify(message, shipped.request.url ? "info" : "warning");
  pi.sendMessage({ customType: "waicc-ship", content: json(shipped), display: true }, { triggerTurn: false });
  return shipped;
}

/** /waicc-ship [--into branch] [--branch name] [--remote r] [--draft] */
export function parseShipArgs(args: string): ShipOptions {
  const words = args.trim().split(/\s+/).filter(Boolean);
  const options: ShipOptions = {};
  for (let i = 0; i < words.length; i++) {
    const flag = words[i];
    if (flag === "--draft") {
      options.draft = true;
      continue;
    }
    const value = words[++i];
    ensure(["--into", "--branch", "--remote"].includes(flag), `Unknown option ${flag}. Usage: /waicc-ship [--into <branch>] [--branch <name>] [--remote <remote>] [--draft]`);
    ensure(value && !value.startsWith("-"), `${flag} requires a value`);
    if (flag === "--into") options.into = value;
    else if (flag === "--branch") options.branch = value;
    else options.remote = value;
  }
  return options;
}

export function registerShipCommands(app: App): void {
  const { command, selected } = app;
  command(
    "waicc-ship",
    "Commit the reviewed change on its own branch, push it and open the merge request, then close the session (after you confirm)",
    async (args, ctx) => {
      await shipSession(app, ctx, selected(ctx), parseShipArgs(args));
    },
  );
}
