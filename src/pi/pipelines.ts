import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { json, loadSession } from "../files.ts";
import { canonicalProject, gitlabClient, gitlabProject } from "../gitlab.ts";
import { checkCommands, runAgent } from "../dispatch.ts";
import { loadAgentConfig, sandboxSettings } from "../profiles.ts";
import { sandboxPlan } from "../sandbox.ts";
import { ciFile, cleanLog, githubChecks, gitlabPipeline, hasCiFile, recordPipeline, type FailedJob, type PipelineMark, type PipelineResult } from "../pipelines.ts";
import { projectRoot } from "../source.ts";
import { chooseRemote } from "../revision.ts";
import type { Shipped } from "../types.ts";
import { resolveGitlabHost } from "./merge-requests.ts";
import { reportRun } from "../queue.ts";
import type { App } from "./app.ts";

/** At most this many automatic fixes of a failed pipeline per session, in one Pi process. */
export const pipelineFixes = 2;
const giveUpMs = 2 * 60 * 60_000, noPipelineMs = 15 * 60_000;

// One watcher per session, process-wide, so a /reload replaces it instead of adding one.
const watchers: Map<string, { timer: ReturnType<typeof setInterval>; chat: string }> =
  ((globalThis as Record<symbol, unknown>)[Symbol.for("pi-waicc.pipeline-watchers")] ??= new Map()) as Map<string, { timer: ReturnType<typeof setInterval>; chat: string }>;
const fixes = new Map<string, number>();

export function stopPipelineWatch(id: string): void {
  clearInterval(watchers.get(id)?.timer);
  watchers.delete(id);
}
/** Pi is closing this chat: its watchers would report into a chat that is gone. */
export function stopPipelineWatches(chat: string): void {
  for (const [id, watcher] of watchers) if (watcher.chat === chat) stopPipelineWatch(id);
}

/** How the shipped commit's pipeline is read, or why it cannot be. */
async function reader(app: App, ctx: ExtensionCommandContext, shipped: Shipped): Promise<(() => Promise<PipelineResult>) | string> {
  const { services } = app;
  const root = projectRoot(ctx.cwd);
  if (shipped.provider === "github") return () => (services.githubChecks ?? githubChecks)(root, shipped);
  let project = null;
  try {
    // The merge request's own address names the project; without one, the remote's.
    const url = shipped.request.url?.replace(/\/-\/merge_requests\/\d+$/, "") ?? chooseRemote(root, shipped.remote).url;
    project = url ? gitlabProject(url) : null;
  } catch { /* reported below */ }
  if (!project) return "WAICC does not know the GitLab project for this merge request";
  project = await (services.gitlabOrigin ?? canonicalProject)(project);
  const host = resolveGitlabHost(ctx.cwd, project.host);
  if (!host?.token) return `reading pipelines needs a GitLab token for ${project.host} in your user file`;
  const call = (services.gitlab ?? gitlabClient)(project, host);
  return () => gitlabPipeline(call, shipped);
}

/**
 * A project without CI: the checks you set for your testing role (or else the implementation role)
 * run on the shipped source instead of a pipeline, read like one. Checks from the project file run
 * only once you confirm them. Null when there are none to run.
 */
async function localChecks(app: App, ctx: ExtensionCommandContext, root: string): Promise<{ read: () => Promise<PipelineResult>; names: string } | null> {
  let config;
  try {
    config = loadAgentConfig(ctx.cwd);
  } catch {
    return null; // A broken config is reported where it is used; here it only means no checks.
  }
  const role = config.roles.testing?.checks?.length ? config.roles.testing : config.roles.implementation?.checks?.length ? config.roles.implementation : undefined;
  if (!role) return null;
  const commands = checkCommands(role.checks!, role.checkTimeoutMinutes);
  const names = role.checks!.join(", ");
  if (role.source === "project") {
    if (!ctx.hasUI || !(await ctx.ui.confirm("This project has no CI. Run the checks from its WAICC file on the shipped source?", role.checks!.join("\n")))) return null;
  }
  const run = app.services.runCheck ?? runAgent, sandbox = sandboxSettings(ctx.cwd);
  const read = async (): Promise<PipelineResult> => {
    const failed: FailedJob[] = [];
    for (const [i, command] of commands.entries()) {
      const plan = sandboxPlan(command.program, command.args, root, sandbox);
      const outcome = await run(plan.program, plan.args, { cwd: root, timeout: command.timeoutMs });
      if (outcome.code !== 0 || outcome.killed)
        failed.push({ name: role.checks![i], url: null, log: cleanLog(`${outcome.killed ? `Stopped after ${command.timeoutMs / 60_000} minutes.\n` : ""}${outcome.stdout}\n${outcome.stderr}`) });
    }
    return { state: failed.length ? "failed" : "success", url: null, failed, local: true };
  };
  return { read, names };
}

/**
 * After /waicc-ship: follows the shipped commit's pipeline until it ends, then says how it went.
 * A failure from a --ship run is fixed automatically (at most pipelineFixes times); after a
 * typed /waicc-ship you are asked first.
 */
export async function watchPipeline(app: App, ctx: ExtensionCommandContext, id: string, automatic: boolean): Promise<void> {
  const { pi, services, notice, key, track } = app;
  const root = projectRoot(ctx.cwd);
  const shipped = loadSession(root, id).shipped;
  if (!shipped) return;
  const where = shipped.request.url ?? `branch ${shipped.branch}`;
  // How it stands, for the queue that started this Pi and for the tracker page.
  const report = (state: PipelineMark["state"], text: string, url: string | null = null) => {
    if (state !== "watching") reportRun({ kind: "pipeline", outcome: state, text });
    recordPipeline(root, id, { state, text, url, commit: shipped.commit });
    track(ctx);
  };
  const say = (level: "info" | "warning" | "error", message: string) => {
    notice(ctx, level, message);
    ctx.ui.notify(message, level);
    pi.sendMessage({ customType: "waicc-pipeline", content: message, display: true }, { triggerTurn: false });
  };
  // Without a CI file no pipeline is likely to come (GitLab can be set to read one from elsewhere):
  // your checks run here instead, or else WAICC waits two polls, not 15 minutes.
  const noCi = hasCiFile(root, shipped) === false;
  const local = noCi ? await localChecks(app, ctx, root) : null;
  const read = local?.read ?? await reader(app, ctx, shipped);
  if (typeof read === "string") {
    report("not-watching", read);
    return say("info", `Not watching the pipeline for ${where}: ${read}.`);
  }
  stopPipelineWatch(id);
  const pollMs = services.pipelinePollMs ?? 60_000;
  const what = local ? "local checks" : "pipeline", What = local ? "The local checks" : "The pipeline";
  const started = Date.now();
  let busy = false, errors = 0, seen = false;
  const done = async (result: PipelineResult) => {
    stopPipelineWatch(id);
    const link = result.url ? ` (${result.url})` : "";
    if (result.state === "success") {
      report("passed", `${What} passed${link}.`, result.url);
      return say("info", `✅ ${What} passed for ${where}${link}${local ? `: ${local.names}` : ""}.`);
    }
    if (result.state !== "failed") report("ended", `The pipeline ended: ${result.state}${link}.`, result.url);
    if (result.state !== "failed")
      return say("warning", result.state === "manual" ? `The pipeline for ${where} waits for a manual job${link}.` : `The pipeline for ${where} was ${result.state === "none" ? "not started" : "canceled or skipped"}${link}.`);
    const names = result.failed.map((job) => job.name).join(", ") || "a job";
    say("error", `❌ ${What} failed for ${where}: ${names}${link}.`);
    const tried = fixes.get(id) ?? 0;
    const fix = () => {
      fixes.set(id, tried + 1);
      report("fixing", names, result.url);
      return app.fixPipeline(ctx, id, result).catch((error) => {
        report("failed", `${What} failed (${names}), and the fix could not start.`, result.url);
        say("error", `The fix could not start: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    if (automatic && tried < pipelineFixes) {
      say("info", `Fixing it automatically, as your --ship run allows (attempt ${tried + 1} of ${pipelineFixes}): the session is reopened, the main agent fixes it, a review runs, then it ships again.`);
      return void fix();
    }
    if (!automatic || tried >= pipelineFixes) report("failed", `${What} failed: ${names}${link}.`, result.url);
    if (automatic) return say("warning", `${What} still fail${local ? "" : "s"} after ${pipelineFixes} automatic fixes. Look at the ${local ? "output" : "jobs"} yourself; /waicc-reopen <reason> to work on it in this session.`);
    if (!ctx.hasUI) return;
    const picked = await ctx.ui.select(`${What} failed (${names}). Fix it?`, ["Fix it: reopen the session, the main agent fixes it, a review runs, then ship again", "Leave it"]);
    if (picked?.startsWith("Fix it")) void fix();
  };
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await read();
      errors = 0;
      if (result.state !== "pending" && result.state !== "none") return void (await done(result));
      seen ||= result.url !== null && result.state === "pending";
      if (!seen && noCi && Date.now() - started >= 2 * pollMs) {
        stopPipelineWatch(id);
        report("ended", `No pipeline: the shipped commit has no ${ciFile(shipped)}.`);
        return say("info", `No pipeline to watch for ${where}: the shipped commit has no ${ciFile(shipped)}, so this project seems to have no CI. To check it here instead, set "checks" for your testing role in your user file, for example ["npm test"].`);
      }
      if (Date.now() - started > (seen ? giveUpMs : noPipelineMs)) {
        stopPipelineWatch(id);
        report("ended", seen ? "Still running after 2 hours." : "No pipeline appeared.");
        say("warning", seen ? `Stopped watching the pipeline for ${where} after 2 hours; it was still running.` : `No pipeline appeared for ${where} within 15 minutes, so there is nothing to watch.`);
      }
    } catch (error) {
      // Local checks that cannot start (a required sandbox, a missing program) would only fail again.
      if (local || ++errors >= 5) {
        stopPipelineWatch(id);
        report("ended", `Could not ${local ? "run the local checks" : "read the pipeline"}: ${error instanceof Error ? error.message : String(error)}`);
        say("warning", `Stopped ${local ? "the local checks" : "watching the pipeline"} for ${where}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  watchers.set(id, { timer, chat: key(ctx) });
  report("watching", local ? `Running the local checks for ${where}: ${local.names}.` : `Watching the pipeline for ${where}.`, shipped.request.url);
  pi.sendMessage({ customType: "waicc-pipeline", content: json({ [local ? "checking" : "watching"]: where, commit: shipped.commit, ...(local ? { checks: local.names } : {}) }), display: false }, { triggerTurn: false });
  ctx.ui.notify(local
    ? `This project has no CI, so your checks run on the shipped source instead (${local.names}): you will hear when they pass or fail.`
    : `Watching the ${what} for ${where}: you will hear when it passes or fails.`, "info");
  // Local checks start now; a pipeline is first read after one poll.
  if (local) void tick();
}
