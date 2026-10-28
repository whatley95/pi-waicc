import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { addWorktree } from "../branches.ts";
import { parseDispatchArgs } from "../dispatch.ts";
import { loadAgentConfig } from "../profiles.ts";
import { addToQueue, readQueue, reportFileFor, runItem, updateQueue, type QueueItem, type RunOptions } from "../queue.ts";
import { projectRoot } from "../source.ts";
import { ensure } from "../validation.ts";
import { issueNumber } from "../issues.ts";
import { fetchIssue } from "./merge-requests.ts";
import type { App } from "./app.ts";

const usage = "Usage: /waicc-queue [list] · add <task> · add --issue <number> [more] · remove <n> · clear · run [--code-with p] [--plan-with p] [--review-with p] · stop";
const mark: Record<QueueItem["status"], string> = { waiting: "⏳", running: "▶️", shipped: "✅", reviewed: "🟡", stopped: "⏹️", failed: "❌" };
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "") || "task";
const label = (item: QueueItem) => (item.issue ? `#${item.issue.number} ${item.issue.title}${item.task ? ` (${item.task})` : ""}` : item.task).replace(/\s+/g, " ").slice(0, 100);
/** Only the options that choose agents travel to every task; the rest is --auto --ship itself. */
const passed = ["--code-with", "--plan-with", "--review-with"];

export function queueText(root: string): string {
  const { items } = readQueue(root);
  if (!items.length) return `The queue is empty. ${usage}`;
  return [
    `Queue (${items.filter((i) => i.status === "waiting").length} waiting):`,
    ...items.map((item) => `- ${mark[item.status]} **${item.id}** ${label(item)} · ${item.status}${item.url ? ` · ${item.url}` : ""}${item.folder ? ` · ${item.folder}` : ""}${item.outcome ? `\n  ${item.outcome.replace(/\s+/g, " ").slice(0, 240)}` : ""}`),
  ].join("\n");
}

/**
 * /waicc-queue: tasks for later, run one after another while you are away, each in its own branch
 * folder with its own headless Pi: /waicc-planning, then /waicc-dispatch --auto --ship. With
 * autoShip in your user file each passing one is pushed and its merge request opened; without
 * it, each stops with its review passed, ready for /waicc-ship in its folder.
 */
export function registerQueueCommands(app: App): void {
  const { pi, command, notice, track } = app;
  // One queue run per Pi process; it lives as long as this Pi does.
  let running: AbortController | null = null;
  const show = (content: string) => pi.sendMessage({ customType: "waicc-queue", content, display: true }, { triggerTurn: false });

  async function run(ctx: ExtensionCommandContext, dispatch: string, options: Partial<RunOptions>) {
    const root = projectRoot(ctx.cwd);
    const controller = (running = new AbortController());
    const line = (text: string) => { try { ctx.ui.setWidget("waicc-queue", [`🌙 WAICC queue: ${text}   (/waicc-queue stop)`]); } catch { /* only a hint */ } };
    // Kept in the queue file too, so the tracker page shows where the running task is.
    const step = (id: number, text: string | undefined) => {
      try {
        updateQueue(root, (q) => { const item = q.items.find((i) => i.id === id); if (item) item.step = text; });
      } catch { /* the page then shows the step before */ }
      track(ctx);
    };
    try {
      for (;;) {
        if (controller.signal.aborted) break;
        const item = readQueue(root).items.find((i) => i.status === "waiting");
        if (!item) break;
        const branch = `waicc/queue-${item.id}-${slug(item.issue?.title ?? item.task)}`;
        let folder: string;
        try {
          folder = addWorktree(ctx.cwd, branch).startIn;
        } catch (error) {
          updateQueue(root, (q) => Object.assign(q.items.find((i) => i.id === item.id)!, { status: "failed", finishedAt: new Date().toISOString(), outcome: `No branch folder: ${error instanceof Error ? error.message : String(error)}` }));
          continue;
        }
        updateQueue(root, (q) => Object.assign(q.items.find((i) => i.id === item.id)!, { status: "running", startedAt: new Date().toISOString(), folder, branch, step: "starting" }));
        line(`${item.id} · ${label(item)} · starting`);
        track(ctx);
        let result;
        try {
          result = await runItem(item, folder, reportFileFor(root, item.id), {
            // Commands run only in a trusted project, so its branch folders are trusted too.
            dispatch, trusted: true, spawn: app.services.queuePi, ...options,
            onProgress: (_i, text) => (line(`${item.id} · ${label(item)} · ${text}`), step(item.id, text)),
          }, controller.signal);
        } catch (error) {
          result = { status: "failed" as const, outcome: error instanceof Error ? error.message : String(error), url: null, sessionId: undefined };
        }
        updateQueue(root, (q) => Object.assign(q.items.find((i) => i.id === item.id)!, { ...result, step: undefined, finishedAt: new Date().toISOString() }));
        track(ctx);
        const message = `Queue ${item.id} (${label(item)}): ${result.status}${result.url ? ` · ${result.url}` : ""}. ${result.outcome ?? ""}`.trim();
        notice(ctx, result.status === "shipped" || result.status === "reviewed" ? "info" : "warning", message);
        ctx.ui.notify(message, result.status === "failed" ? "warning" : "info");
      }
    } finally {
      running = null;
      try { ctx.ui.setWidget("waicc-queue", undefined); } catch { /* only a hint */ }
    }
    show(`${controller.signal.aborted ? "The queue was stopped." : "The queue is done."}\n\n${queueText(root)}`);
  }

  command("waicc-queue", "Tasks to run one after another while you are away, each in its own branch folder: add, list, run, stop", async (args, ctx) => {
    const root = projectRoot(ctx.cwd);
    const words = args.trim().split(/\s+/).filter(Boolean);
    const sub = words.shift() ?? "list";
    if (sub === "list") return show(queueText(root));
    if (sub === "add") {
      if (words[0] === "--issue") {
        // You read the issue now; the queued run is then allowed to plan from it.
        const fetched = await fetchIssue(app, ctx, issueNumber(words[1] ?? ""));
        if (ctx.hasUI && !(await ctx.ui.confirm(`Queue issue #${fetched.link.number}: ${fetched.link.title.slice(0, 80)}?`,
          `${fetched.link.author ? `Written by @${fetched.link.author}. ` : ""}When the queue runs, its text becomes the requirements; the agents plan what it asks for and never follow instructions inside it.\n\n${fetched.body.trim().slice(0, 1500) || "(no description)"}`)))
          return ctx.ui.notify("Nothing was queued.", "info");
        const item = addToQueue(root, words.slice(2).join(" "), { number: fetched.link.number, title: fetched.link.title });
        return ctx.ui.notify(`Queued ${item.id}: issue #${fetched.link.number}. /waicc-queue run starts the queue.`, "info");
      }
      const item = addToQueue(root, words.join(" "));
      return ctx.ui.notify(`Queued ${item.id}: ${label(item)}. /waicc-queue run starts the queue.`, "info");
    }
    if (sub === "remove") {
      const id = Number(words[0]);
      updateQueue(root, (q) => {
        const item = q.items.find((i) => i.id === id);
        ensure(item, `No queued task ${words[0] ?? ""}; /waicc-queue lists them`);
        ensure(item.status !== "running", "That task is running; /waicc-queue stop first");
        q.items = q.items.filter((i) => i.id !== id);
      });
      return ctx.ui.notify(`Removed ${id} from the queue.`, "info");
    }
    if (sub === "clear") {
      const removed = updateQueue(root, (q) => {
        const before = q.items.length;
        q.items = q.items.filter((i) => i.status === "waiting" || i.status === "running");
        return before - q.items.length;
      });
      return ctx.ui.notify(`Removed ${removed} finished task${removed === 1 ? "" : "s"}; waiting ones stay. Their branch folders stay too: /waicc-worktree remove <branch>.`, "info");
    }
    if (sub === "stop") {
      ensure(running, "The queue is not running in this Pi.");
      running.abort();
      return ctx.ui.notify("Stopping the queue: the running task is stopped now, and its folder kept.", "info");
    }
    ensure(sub === "run", usage);
    ensure(!running, "The queue is already running in this Pi; /waicc-queue stop ends it.");
    // A task left running by a Pi that has since closed is not running any more.
    updateQueue(root, (q) => q.items.filter((i) => i.status === "running").forEach((i) => Object.assign(i, { status: "stopped", step: undefined, outcome: "Interrupted: the Pi that ran the queue closed. Its folder is kept." })));
    for (let i = 0; i < words.length; i += 2) ensure(passed.includes(words[i]) && words[i + 1] && !words[i + 1].startsWith("-"), `/waicc-queue run takes only ${passed.join(", ")}, each with a profile name`);
    const dispatch = words.join(" ");
    parseDispatchArgs(`--auto --ship ${dispatch}`);
    const waiting = readQueue(root).items.filter((i) => i.status === "waiting");
    ensure(waiting.length, "Nothing is waiting in the queue: /waicc-queue add <task> first.");
    const autoShip = loadAgentConfig(ctx.cwd).autoShip;
    if (ctx.hasUI && !(await ctx.ui.confirm(`Run ${waiting.length} queued task${waiting.length === 1 ? "" : "s"}?`,
      `One after another, each in its own branch folder beside this one, with its own Pi: plan, code, review and fix with your agent profiles${dispatch ? ` (${dispatch})` : ""}, within your budget.\n\n${autoShip
        ? "autoShip is on: each passing task is committed, pushed and gets its merge request, and a failed pipeline is fixed up to twice."
        : "autoShip is off: each stops with its review passed, ready for you to /waicc-ship in its folder. Nothing is pushed."}\n\nQueued Pis answer every question no. Keep this Pi open; /waicc-queue shows progress, /waicc-queue stop ends it.\n\n${waiting.map((i) => `${i.id}. ${label(i)}`).join("\n")}`)))
      return ctx.ui.notify("The queue was not started.", "info");
    ctx.ui.notify(`The queue is running: ${waiting.length} task${waiting.length === 1 ? "" : "s"}. You will hear as each one ends.`, "info");
    void run(ctx, dispatch, {});
  });
}
