import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { json, loadSession } from "../files.ts";
import { canonicalProject, gitlabClient, gitlabProject } from "../gitlab.ts";
import { githubChecks, gitlabPipeline, recordPipeline, type PipelineMark, type PipelineResult } from "../pipelines.ts";
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
  const read = await reader(app, ctx, shipped);
  if (typeof read === "string") {
    report("not-watching", read);
    return say("info", `Not watching the pipeline for ${where}: ${read}.`);
  }
  stopPipelineWatch(id);
  const started = Date.now();
  let busy = false, errors = 0, seen = false;
  const done = async (result: PipelineResult) => {
    stopPipelineWatch(id);
    const link = result.url ? ` (${result.url})` : "";
    if (result.state === "success") {
      report("passed", `The pipeline passed${link}.`, result.url);
      return say("info", `✅ The pipeline passed for ${where}${link}.`);
    }
    if (result.state !== "failed") report("ended", `The pipeline ended: ${result.state}${link}.`, result.url);
    if (result.state !== "failed")
      return say("warning", result.state === "manual" ? `The pipeline for ${where} waits for a manual job${link}.` : `The pipeline for ${where} was ${result.state === "none" ? "not started" : "canceled or skipped"}${link}.`);
    const names = result.failed.map((job) => job.name).join(", ") || "a job";
    say("error", `❌ The pipeline failed for ${where}: ${names}${link}.`);
    const tried = fixes.get(id) ?? 0;
    const fix = () => {
      fixes.set(id, tried + 1);
      report("fixing", names, result.url);
      return app.fixPipeline(ctx, id, result).catch((error) => {
        report("failed", `The pipeline failed (${names}), and the fix could not start.`, result.url);
        say("error", `The fix could not start: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    if (automatic && tried < pipelineFixes) {
      say("info", `Fixing it automatically, as your --ship run allows (attempt ${tried + 1} of ${pipelineFixes}): the session is reopened, the main agent fixes it, a review runs, then it ships again.`);
      return void fix();
    }
    if (!automatic || tried >= pipelineFixes) report("failed", `The pipeline failed: ${names}${link}.`, result.url);
    if (automatic) return say("warning", `The pipeline still fails after ${pipelineFixes} automatic fixes. Look at the jobs yourself; /waicc-reopen <reason> to work on it in this session.`);
    if (!ctx.hasUI) return;
    const picked = await ctx.ui.select(`The pipeline failed (${names}). Fix it?`, ["Fix it: reopen the session, the main agent fixes it, a review runs, then ship again", "Leave it"]);
    if (picked?.startsWith("Fix it")) void fix();
  };
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const result = await read();
      errors = 0;
      if (result.state !== "pending" && result.state !== "none") return void (await done(result));
      seen ||= result.url !== null && result.state === "pending";
      if (Date.now() - started > (seen ? giveUpMs : noPipelineMs)) {
        stopPipelineWatch(id);
        report("ended", seen ? "Still running after 2 hours." : "No pipeline appeared.");
        say("warning", seen ? `Stopped watching the pipeline for ${where} after 2 hours; it was still running.` : `No pipeline appeared for ${where} within 15 minutes, so there is nothing to watch.`);
      }
    } catch (error) {
      if (++errors >= 5) {
        stopPipelineWatch(id);
        report("ended", `Could not read the pipeline: ${error instanceof Error ? error.message : String(error)}`);
        say("warning", `Stopped watching the pipeline for ${where}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      busy = false;
    }
  }, services.pipelinePollMs ?? 60_000);
  timer.unref?.();
  watchers.set(id, { timer, chat: key(ctx) });
  report("watching", `Watching the pipeline for ${where}.`, shipped.request.url);
  pi.sendMessage({ customType: "waicc-pipeline", content: json({ watching: where, commit: shipped.commit }), display: false }, { triggerTurn: false });
  ctx.ui.notify(`Watching the pipeline for ${where}: you will hear when it passes or fails.`, "info");
}
