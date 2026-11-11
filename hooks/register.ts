import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";
import { statusTable } from "../src/status-table.ts";
import { humanOnlyCommand, sessionArgs, slashCommands, slashFor, statusLine, waiccSection, type SlashCommand } from "../src/claude/commands.ts";

/**
 * WAICC's Claude Code mod: the /waicc-* commands, the session this chat works on, its status line,
 * the main agent's WAICC section of the system prompt, a guard on the agent's shell, and the
 * background dispatch it watches. A mod has no Node: WAICC itself runs as its command line
 * (src/cli.ts) and the main agent's tools as the plugin's MCP server.
 */
const session = atom({ plugin: "waicc", key: "session" } as const, null);
const watched = atom({ plugin: "waicc", key: "watched" } as const, null);
const state = ".pi/pi-waicc";

/** This Claude Code chat as WAICC's logs name it, beside Pi's chats and the MCP server's (mcp-…). */
async function chatName($: EngineInterface): Promise<string> {
  return `claude-${(await $.session.id()).slice(0, 8)}`;
}
/** Runs the waicc command line in this project and reads its JSON answer; its error message on failure. */
async function waicc($: EngineInterface, argv: string[]): Promise<any> {
  const cwd = await $.session.cwd();
  const ran = await $.process.run(["node", `${$.plugin.root}/src/cli.ts`, "--root", cwd, ...argv], { timeoutMs: 120_000, env: { WAICC_CHAT: await chatName($) } });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `waicc ${argv[0]} exited with ${ran.exitCode}`);
  return JSON.parse(ran.stdout);
}
/** One line in WAICC's error or activity log (a mod cannot append to a file itself); never fails what logged it. */
type LogEntry =
  | { kind: "error"; step: string; message: string; level?: "warning"; sessionId?: string }
  | { kind: "activity"; step: string; outcome: string; ms?: number; sessionId?: string; detail?: Record<string, string | number | boolean | null> };
async function log($: EngineInterface, entry: LogEntry): Promise<void> {
  try {
    await waicc($, ["log", JSON.stringify(entry)]);
  } catch { /* the log never stands in the way */ }
}
/** A JSON file of WAICC's state, read without starting a process; null when there is none. */
async function stateFile($: EngineInterface, path: string): Promise<any> {
  try {
    return JSON.parse(await $.fs.read(`${await $.session.cwd()}/${state}/${path}`) as string);
  } catch {
    return null;
  }
}
async function bound($: EngineInterface): Promise<{ id: string; status: string } | null> {
  const id = await read($, session);
  if (!id) return null;
  const saved = await stateFile($, `sessions/${id}/session.json`);
  return saved ? { id, status: String(saved.status) } : null;
}
async function showStatus($: EngineInterface): Promise<void> {
  const current = await bound($);
  $.ui.status(current ? statusLine(current.id, current.status) : undefined);
}

/** What a command shows: its view as WAICC's status tables where it is one, else the essentials. */
function shown(command: SlashCommand, value: any): string {
  if (command.name === "waicc-decisions" && Array.isArray(value?.decisions))
    return value.decisions.length
      ? value.decisions.map((d: any) => `- ${d.id} (${d.owner}, ${d.status}): ${d.question}${d.answer ? ` → ${d.answer}` : d.recommendation ? ` (recommended: ${d.recommendation})` : ""}`).join("\n")
      : "This session has no decisions.";
  const table = statusTable(value);
  if (table) return table;
  const text = JSON.stringify(value, null, 2);
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

async function run($: EngineInterface, command: SlashCommand, args: string): Promise<{ text: string }> {
  const { id: named, rest } = sessionArgs(args);
  const id = command.session === "none" ? named : named ?? (await read($, session)) ?? undefined;
  // A refusal is logged as Pi logs its commands' (the command line logs its own errors too).
  const refused = async (message: string) => {
    await log($, { kind: "error", step: `/${command.name}`, message, ...(id ? { sessionId: id } : {}) });
    return { text: message };
  };
  if (command.session === "required" && !id)
    return refused("No WAICC session is selected in this chat: /waicc-planning <request> starts one, /waicc-use <session-id> selects one.");
  let value: any;
  try {
    const argv = command.cli(id, rest);
    if (argv) value = await waicc($, argv);
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error));
  }
  // The session this chat works on from now on.
  const now = command.binds === "new" ? String(value.id) : command.binds === "named" ? id! : command.binds === "none" ? null : undefined;
  if (now !== undefined) await update($, session, () => now);
  const target = now ?? id;
  let text: string;
  if (command.name === "waicc-dispatch") {
    await update($, watched, () => id!);
    text = `Dispatched in the background (process ${value.pid}). You are told here when it ends; its live steps go to ${value.log}.`;
  } else if (command.name === "waicc-handoff") {
    const prompt = value?.manualHandoff?.copyPastePrompt;
    if (!prompt) text = "No handoff is waiting in this session.";
    else {
      const copied = await $.ui.copy({ text: prompt });
      text = `${copied.isCopied ? "Copied. " : ""}Give this to the agent, which needs access to the project, hidden .pi files included; then /waicc-continue:\n\n${prompt}`;
    }
  } else if (value === undefined) text = "Asked the main agent.";
  else if (["waicc-status", "waicc-use", "waicc-decisions", "waicc-memory"].includes(command.name) || !target) text = shown(command, value);
  else {
    // A step that changed the session: show where it stands now.
    let view: any = value;
    try {
      view = await waicc($, ["status", target]);
    } catch { /* its own answer stands */ }
    text = shown(command, view);
  }
  await showStatus($);
  if (command.agent && target) await $.prompt.submit({ text: command.agent(target, rest) });
  return { text };
}

/** Every few seconds: whether the watched background dispatch has ended, and its time while it runs. */
async function watch($: EngineInterface): Promise<void> {
  const id = await read($, watched);
  if (!id) return;
  const runFile = await stateFile($, `runs/${id}.json`);
  if (!runFile) return;
  if (!runFile.endedAt) {
    const minutes = Math.floor((Date.now() - Date.parse(runFile.startedAt)) / 60_000);
    $.ui.status(`WAICC ${id.slice(0, 8)} · dispatching${minutes ? ` · ${minutes} min` : ""}`);
    return;
  }
  await update($, watched, () => null);
  await log($, { kind: "activity", step: "dispatch watch", outcome: String(runFile.outcome ?? "ended"), sessionId: id,
    ms: Date.parse(runFile.endedAt) - Date.parse(runFile.startedAt) });
  $.ui.toast(runFile.message ?? "The dispatch ended.");
  void $.ui.notify(runFile.message ?? "The dispatch ended.", { title: "WAICC" });
  await showStatus($);
}

/**
 * WAICC's human steps are the human's: the agent's shell may only read WAICC's state. A shell
 * line the human runs (Claude Code's "!") is no tool call of the model's and has no tool_use_id.
 */
async function guard($: EngineInterface, e: { command: string; tool_use_id?: string }, next: (e: any) => any) {
  const command = e.tool_use_id ? humanOnlyCommand(e.command) : null;
  if (!command) return next(e);
  const current = await read($, session);
  await log($, { kind: "error", step: "shell guard", message: `Refused the agent's "waicc ${command}"`, level: "warning", ...(current ? { sessionId: current } : {}) });
  return { deny: `"waicc ${command}" is the human's step, not yours: tell the human to type ${slashFor(command)} and end your turn. Use the WAICC tools for your own part.` };
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    for (const command of slashCommands)
      await $.command.register({ name: command.name, description: command.description, ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}) });
    $.clock.every(3_000, () => void watch($));
    await showStatus($);
    return next(e);
  });
  for (const command of slashCommands)
    on("command.run", { command: command.name }, ($, e) => run($, command, e.args))
      .catch(async ($) => {
        await log($, { kind: "error", step: `/${command.name}`, message: "The mod's command failed" });
        return { text: `/${command.name} failed inside WAICC's Claude Code mod; the waicc command line does the same: ! waicc --help` };
      });

  on("tool.call", { tool: "Bash" }, guard);
  on("tool.call", { tool: "PowerShell" }, guard);

  // After each of the main agent's WAICC tools, the status line shows where the session stands.
  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (String(e.tool).startsWith("mcp__plugin_waicc_waicc__")) await showStatus($);
    return result;
  }).catch(($, e, next) => next(e)); // A status line that failed never costs the tool its result.

  // Each main-agent turn, as Pi logs its own: how long it took and how it ended.
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) {
      const current = await read($, session);
      await log($, { kind: "activity", step: "main turn", outcome: e.reason, ms: e.durationMs, ...(current ? { sessionId: current } : {}) });
    }
    return result;
  }).catch(($, e, next) => next(e));

  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    return { sections: [...composed.sections, { id: "waicc:session", text: waiccSection(await bound($)), scope: "session" as const }] };
  });
};
