import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";
import { statusTable } from "../src/status-table.ts";
import { autoPlanningInstructions } from "../src/auto-planning-text.ts";
import { compactionInstructions } from "../src/compaction-text.ts";
import { nudgeText, pathsPauseText } from "../src/loop-text.ts";
import { startPlanningSpec } from "../src/tool-specs.ts";
import {
  dispatchArgs, humanOnlyCommand, loopPrompt, offeredCommand, sessionArgs, slashCommands, slashFor, statusLine, suggestSpec, waiccSection,
  type SlashCommand,
} from "../src/claude/commands.ts";

/**
 * WAICC's Claude Code mod: the /waicc-* commands, the session this chat works on, its status line,
 * the main agent's WAICC section of the system prompt, auto-planning, the command picker, a guard
 * on the agent's shell, and the background dispatch (and review loop) it watches. A mod has no
 * Node: WAICC itself runs as its command line (src/cli.ts) and the main agent's other tools as the
 * plugin's MCP server.
 */
const session = atom({ plugin: "waicc", key: "session" } as const, null);
const watched = atom({ plugin: "waicc", key: "watched" } as const, null);
const request = atom({ plugin: "waicc", key: "request" } as const, null);
const autoPlanning = atom({ plugin: "waicc", key: "autoPlanning" } as const, true);
const offers = atom({ plugin: "waicc", key: "offers" } as const, null);
const loop = atom({ plugin: "waicc", key: "loop" } as const, null);
const state = ".pi/pi-waicc";
/** The mod's own tools, as the model sees them. */
const startTool = "mcp__waicc__waicc_start_planning";
const suggestTool = "mcp__waicc__waicc_suggest_command";

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
/** Why a hook failed, in one line for the human and the error log. */
function failure(error: { kind: string; message?: string }): string {
  if (error.kind === "timeout") return "it took too long";
  return (error.message ?? "unknown error").replace(/\s+/g, " ").trim().slice(0, 500);
}
type LogEntry =
  | { kind: "error"; step: string; message: string; level?: "warning"; sessionId?: string }
  | { kind: "activity"; step: string; outcome: string; ms?: number; sessionId?: string; detail?: Record<string, string | number | boolean | null> };
/** One line in WAICC's error or activity log (a mod cannot append to a file itself); never fails what logged it. */
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
/** The session's waiting handoff, if one waits: its mode and review kind. */
async function waiting($: EngineInterface, id: string): Promise<{ mode: string; kind?: string } | null> {
  const saved = await stateFile($, `sessions/${id}/session.json`);
  const round = (saved?.rounds ?? []).findLast((r: any) => r.status === "WAITING");
  return round ? { mode: String(round.mode), ...(round.review?.kind ? { kind: String(round.review.kind) } : {}) } : null;
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
  if (command.name === "waicc-auto-planning") {
    if (rest && !["on", "off"].includes(rest)) return refused("Usage: /waicc-auto-planning [on|off]");
    if (rest) await update($, autoPlanning, () => rest === "on");
    return { text: `Automatic planning is ${(await read($, autoPlanning)) ? "on: the main agent may start a planning session from a request that needs tracked steps ([no-plan] at the start of a message skips it once)" : "off: /waicc-planning <request> starts a session"}.` };
  }
  // A review loop needs a code review waiting: each cycle the main agent fixes, and WAICC sends the next review.
  let cycles: number | null = null;
  if (command.name === "waicc-dispatch") {
    try {
      cycles = dispatchArgs(rest).loop;
    } catch (error) {
      return refused(error instanceof Error ? error.message : String(error));
    }
    const handoff = cycles ? await waiting($, id!) : null;
    if (cycles && !(handoff?.mode === "review" && handoff.kind === "code"))
      return refused("--loop runs code reviews and the main agent's fixes; the waiting handoff is not a code review. Dispatch it without --loop.");
  }
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
    if (cycles) await update($, loop, () => ({ sessionId: id!, cycle: 1, max: cycles!, args: dispatchArgs(rest).args, waiting: "dispatch" as const }));
    text = `Dispatched in the background (process ${value.pid})${cycles ? `, as cycle 1 of a review loop of at most ${cycles}` : ""}. You are told here when it ends; its live steps go to ${value.log}.`;
  } else if (command.name === "waicc-handoff") {
    const prompt = value?.manualHandoff?.copyPastePrompt;
    if (!prompt) text = "No handoff is waiting in this session.";
    else {
      const copied = await $.ui.copy({ text: prompt });
      text = `${copied.isCopied ? "Copied. " : ""}Give this to the agent, which needs access to the project, hidden .pi files included; then /waicc-continue:\n\n${prompt}`;
    }
  } else if (value === undefined) text = "Asked the main agent.";
  else if (["waicc-status", "waicc-use", "waicc-decisions", "waicc-memory", "waicc-list", "waicc-export"].includes(command.name) || !target) text = shown(command, value);
  else {
    // A step that changed the session: show where it stands now.
    let view: any = value;
    try {
      view = await waicc($, ["status", target]);
    } catch { /* its own answer stands */ }
    text = shown(command, view);
  }
  await showStatus($);
  if (command.agent && (target || command.session === "none")) await $.prompt.submit({ text: command.agent(target ?? "", rest, value) });
  return { text };
}

/** Whether the main agent's turn is running: a reply is taken in only between turns, as Pi waits for idle. */
let busy = false;
/** The human's autoContinue setting, read from the command line at most every 30 s. */
let autoContinueSetting: { on: boolean; at: number } | null = null;
async function autoContinue($: EngineInterface): Promise<boolean> {
  if (autoContinueSetting && Date.now() - autoContinueSetting.at < 30_000) return autoContinueSetting.on;
  let on = false;
  try {
    on = (await waicc($, ["profiles"]))?.autoContinue === true;
  } catch { /* a broken settings file: nothing continues by itself */ }
  autoContinueSetting = { on, at: Date.now() };
  return on;
}
/** A reply's file and time already tried, so a reply that could not be taken in is not tried again until it changes. */
let tried: string | undefined;
/** autoContinue: take the reply in and have the main agent assess it, as /waicc-continue does. */
async function continueReply($: EngineInterface, id: string, from: string): Promise<void> {
  try {
    await waicc($, ["continue", id]);
  } catch (error) {
    const message = `A reply arrived but could not be taken in: ${error instanceof Error ? error.message : String(error)}. Fix reply.json, or run /waicc-continue.`;
    await log($, { kind: "error", step: "auto continue", message, sessionId: id });
    $.ui.toast(message);
    return;
  }
  await log($, { kind: "activity", step: "auto continue", outcome: from, sessionId: id });
  $.ui.toast("A reply arrived; continuing automatically (autoContinue): the main agent assesses it.");
  await showStatus($);
  const prompt = slashCommands.find((c) => c.name === "waicc-continue")?.agent?.(id, "");
  if (prompt) await $.prompt.submit({ text: prompt });
}
/** A reply to a handoff given out by hand: with autoContinue on, taken in once it has stopped changing. */
async function watchReply($: EngineInterface): Promise<void> {
  if (busy || !(await autoContinue($))) return;
  const id = await read($, session);
  if (!id) return;
  const handoff = (await stateFile($, `sessions/${id}/session.json`))?.rounds?.findLast((r: any) => r.status === "WAITING");
  if (!handoff) return;
  const path = `${await $.session.cwd()}/${state}/sessions/${id}/rounds/${handoff.id}/reply.json`;
  let changed: number;
  try {
    changed = (await $.fs.stat(path)).mtimeMs;
  } catch {
    return; // No reply yet.
  }
  // Still being written, or this version already tried: wait.
  if (Date.now() - changed < 3_000 || tried === `${path}:${changed}`) return;
  tried = `${path}:${changed}`;
  await continueReply($, id, "handoff");
}

/** Every few seconds: whether the watched background dispatch has ended, and its time while it runs. */
async function watch($: EngineInterface): Promise<void> {
  const id = await read($, watched);
  if (!id) return watchReply($);
  const runFile = await stateFile($, `runs/${id}.json`);
  if (!runFile) return;
  if (!runFile.endedAt) {
    const minutes = Math.floor((Date.now() - Date.parse(runFile.startedAt)) / 60_000);
    $.ui.status(`WAICC ${id.slice(0, 8)} · dispatching${minutes ? ` · ${minutes} min` : ""}`);
    return;
  }
  const looping = await read($, loop);
  const continuing = runFile.outcome === "reply" && (looping?.sessionId === id || (await autoContinue($)));
  // Taken in between the main agent's turns, never during one: the next tick tries again.
  if (continuing && busy) return;
  await update($, watched, () => null);
  await log($, { kind: "activity", step: "dispatch watch", outcome: String(runFile.outcome ?? "ended"), sessionId: id,
    ms: Date.parse(runFile.endedAt) - Date.parse(runFile.startedAt) });
  if (continuing && looping?.sessionId !== id) {
    void $.ui.notify(runFile.message ?? "The dispatch replied.", { title: "WAICC" });
    return continueReply($, id, "dispatch");
  }
  if (looping?.sessionId === id && looping.waiting === "dispatch") {
    if (runFile.outcome === "reply") {
      // The reply goes to the main agent at once: assess, fix, and ask for the next review.
      try {
        await waicc($, ["continue", id]);
        await update($, loop, () => ({ ...looping, waiting: "turn" as const }));
        $.ui.toast(`Review loop, cycle ${looping.cycle} of ${looping.max}: the review is in; the main agent assesses and fixes.`);
        await $.prompt.submit({ text: loopPrompt(id, looping.cycle, looping.max) });
      } catch (error) {
        await stopLoop($, `Review loop stopped at cycle ${looping.cycle}: ${error instanceof Error ? error.message : String(error)}`, id);
      }
      await showStatus($);
      return;
    }
    await stopLoop($, `Review loop stopped at cycle ${looping.cycle}: ${runFile.message ?? "the dispatch ended without a reply"}`, id);
    await showStatus($);
    return;
  }
  $.ui.toast(runFile.message ?? "The dispatch ended.");
  void $.ui.notify(runFile.message ?? "The dispatch ended.", { title: "WAICC" });
  await showStatus($);
}
async function stopLoop($: EngineInterface, message: string, id: string, warning = true): Promise<void> {
  await update($, loop, () => null);
  if (warning) await log($, { kind: "error", step: "loop", message, level: "warning", sessionId: id });
  $.ui.toast(message);
  void $.ui.notify(message, { title: "WAICC" });
}
/** After the main agent's turn in a review loop: send the review it asked for, or say why the loop ends. */
async function afterLoopTurn($: EngineInterface): Promise<void> {
  const looping = await read($, loop);
  if (!looping || looping.waiting !== "turn") return;
  const id = looping.sessionId;
  const handoff = await waiting($, id);
  if (handoff?.mode === "review" && handoff.kind === "code") {
    if (looping.cycle >= looping.max)
      return stopLoop($, `Review loop stopped after ${looping.max} cycles; a fresh review is waiting: /waicc-dispatch sends it.`, id);
    try {
      await waicc($, ["dispatch", id, ...looping.args, "--detach"]);
      await update($, loop, () => ({ ...looping, cycle: looping.cycle + 1, waiting: "dispatch" as const }));
      await update($, watched, () => id);
      $.ui.toast(`Review loop, cycle ${looping.cycle + 1} of ${looping.max}: the fresh review is dispatched.`);
    } catch (error) {
      await stopLoop($, `Review loop stopped at cycle ${looping.cycle}: ${error instanceof Error ? error.message : String(error)}`, id);
    }
    return;
  }
  const current = await bound($);
  if (current?.status === "READY_TO_CLOSE")
    return stopLoop($, `Review loop finished in ${looping.cycle} cycle${looping.cycle > 1 ? "s" : ""}: the review passed. /waicc-close <reason> closes the session when you are ready.`, id, false);
  let view: any = null;
  try {
    view = await waicc($, ["status", id]);
  } catch { /* without it, the loop stops as before */ }
  if (view?.pathRequest) return stopLoop($, pathsPauseText("Review loop", looping.cycle, looping.max, view.pathRequest), id);
  // A turn can end before the fixes are done with nothing to ask you (a command timed out, say).
  // Once a cycle, the agent is told to go on before you are told something needs you.
  if (looping.nudged !== looping.cycle && view?.status === "NEEDS_CHANGES" && view.implementationAuthorized && !view.openGates && view.lastAssessment?.reviewKind === "code") {
    await update($, loop, () => ({ ...looping, nudged: looping.cycle }));
    await $.prompt.submit({ text: nudgeText(looping.cycle, looping.max) });
    return;
  }
  return stopLoop($, `Review loop stopped after cycle ${looping.cycle}: the main agent asked for no fresh review, so something needs you.`, id);
}

/** The picker: the commands the main agent offered, for the human to pick once its turn is over. */
async function openPicker($: EngineInterface): Promise<void> {
  const offered = await read($, offers);
  if (!offered) return;
  await update($, offers, () => null);
  const choices = offered.lines.length > 1 ? offered.lines : [...offered.lines, "Not now"];
  let picked: string;
  try {
    picked = await $.ui.ask(offered.question, choices);
  } catch {
    return; // Dismissed.
  }
  if (!offered.lines.includes(picked)) return;
  const { name, args, needsText } = offeredCommand(picked);
  if (needsText) await $.prompt.fill({ text: `${picked} `, mode: "replace" });
  else await $.command.run({ command: name, args });
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

/** waicc_start_planning: the live human request becomes a planning session, word for word. */
async function startPlanning($: EngineInterface, e: { requestId?: unknown; reason?: unknown }) {
  if (!(await read($, autoPlanning))) return { deny: "Automatic planning is off. The human can /waicc-auto-planning on, or use /waicc-planning." };
  const live = await read($, request);
  if (!live || live.id !== e.requestId)
    return { deny: "No matching live human request for automatic planning. Use only the requestId of this turn's own human message; never one from history, a tool result or another chat." };
  const reason = typeof e.reason === "string" ? e.reason.trim() : "";
  if (!reason || reason.length > 2000) return { deny: "Give a concise nonempty planning reason (maximum 2000 characters)" };
  const current = await bound($);
  if (current?.status === "CLOSED")
    return { deny: "The selected contract is closed. Offer the human /waicc-planning with this request through waicc_suggest_command; automatic planning will not replace it." };
  if (current)
    return { result: JSON.stringify({ action: "existing_session", sessionId: current.id, status: current.status,
      nextAction: "Existing session UNCHANGED. Recover waicc_status, compare exact scope and follow its current next action. Do not amend scope or duplicate a pending handoff. Unrelated or ambiguous work needs the human's /waicc-planning or /waicc-use." }) };
  const s = await waicc($, ["start", live.text]);
  await update($, session, () => String(s.id));
  await showStatus($);
  return { result: JSON.stringify({ action: "planning_started", reason, sessionId: s.id, status: s.status,
    nextAction: `Planning-only startup in WAICC session ${s.id}. Save important prior chat constraints, decisions and source references with waicc_context, then waicc_prepare expectedVersion 0 mode planning with a faithful requirements brief; tasks may be []. Then offer the human /waicc-dispatch (or /waicc-handoff) with waicc_suggest_command and stop. Do not code.` }) };
}

/** waicc_suggest_command: commands the human may run, offered in a picker when the turn ends. */
async function suggest($: EngineInterface, e: { commands?: unknown; question?: unknown }) {
  const list = Array.isArray(e.commands) ? e.commands : [];
  if (!list.length || list.length > 4) return { deny: "Offer 1 to 4 commands, each { command, why }." };
  const lines: string[] = [];
  for (const item of list) {
    const line = String((item as { command?: unknown })?.command ?? "").replace(/\s+/g, " ").trim();
    try {
      offeredCommand(line);
    } catch (error) {
      return { deny: error instanceof Error ? error.message : String(error) };
    }
    if (!lines.includes(line)) lines.push(line);
  }
  const question = typeof e.question === "string" && e.question.trim() ? e.question.trim().slice(0, 200) : "The agent suggests a WAICC command";
  await update($, offers, () => ({ question, lines }));
  return { result: `Offered to the human in a picker that opens when your turn ends: ${lines.join(", ")}. End your turn now; what they pick runs as their own command.` };
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    for (const command of slashCommands)
      await $.command.register({ name: command.name, description: command.description, ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}) });
    await $.tool.register({ name: "waicc_start_planning", description: startPlanningSpec.description, inputSchema: startPlanningSpec.parameters, isDeferred: false });
    await $.tool.register({ name: "waicc_suggest_command", description: suggestSpec.description, inputSchema: suggestSpec.parameters, isDeferred: false });
    $.clock.every(3_000, () => void watch($));
    await showStatus($);
    return next(e);
  });
  for (const command of slashCommands)
    on("command.run", { command: command.name }, ($, e) => run($, command, e.args))
      .catch(async ($, e, next) => {
        const why = failure(next.error);
        await log($, { kind: "error", step: `/${command.name}`, message: `The mod's command failed: ${why}` });
        return { text: `/${command.name} failed inside WAICC's Claude Code mod (${why}); the waicc command line does the same: ! waicc --help` };
      });

  on("tool.call", { tool: startTool }, ($, e) => startPlanning($, e as { requestId?: unknown; reason?: unknown }))
    .catch(async ($, e, next) => {
      const why = failure(next.error);
      await log($, { kind: "error", step: "waicc_start_planning", message: why });
      return { deny: `waicc_start_planning failed inside WAICC's mod (${why}); show the human this error and ask them to use /waicc-planning.` };
    });
  on("tool.call", { tool: suggestTool }, ($, e) => suggest($, e as { commands?: unknown; question?: unknown }))
    .catch(($, e, next) => ({ deny: `waicc_suggest_command failed inside WAICC's mod (${failure(next.error)}); write the command in your reply instead.` }));

  on("tool.call", { tool: "Bash" }, guard);
  on("tool.call", { tool: "PowerShell" }, guard);

  // After each of the main agent's WAICC tools, the status line shows where the session stands.
  on("tool.call", async ($, e, next) => {
    const result = await next(e);
    if (String(e.tool).startsWith("mcp__plugin_waicc_waicc__")) await showStatus($);
    return result;
  }).catch(($, e, next) => next(e)); // A status line that failed never costs the tool its result.

  // Auto-planning: the human's own message, kept for this turn, may become a planning session.
  on("prompt.submit", async ($, e, next) => {
    const own = !e.command && !e.isMeta && !/^\s*\[no-plan\]/i.test(e.text) && (e as { origin?: { kind?: string } }).origin?.kind !== "plugin";
    if (!own || !(await read($, autoPlanning))) return next(e);
    const id = crypto.randomUUID();
    await update($, request, () => ({ id, text: e.text }));
    return next({ ...e, context: [...(e.context ?? []), autoPlanningInstructions(id, (await bound($)) !== null)] });
  }).catch(($, e, next) => next(e));

  // Each main-agent turn, as Pi logs its own; then the picker and the review loop's next step.
  on("turn.start", ($, e, next) => {
    if (e.agentId === undefined) busy = true;
    return next(e);
  });
  // WAICC's recovery notes in the summary of a compacted chat, as Pi asks of its own compaction.
  on("session.compact", async ($, e, next) => {
    const id = e.agentId === undefined ? await read($, session) : null;
    if (!id) return next(e);
    let recovery: unknown;
    try {
      recovery = await waicc($, ["checkpoint", id]);
    } catch {
      return next(e); // No checkpoint to keep: the session line is added back on every request anyway.
    }
    return next({ ...e, instructions: [e.instructions, compactionInstructions(recovery)].filter(Boolean).join("\n\n") });
  }).catch(($, e, next) => next(e));

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) busy = false;
    if (e.agentId === undefined) {
      const current = await read($, session);
      // The turn's line in the activity log and its tokens on the tracker page, as Pi's chats are counted.
      try {
        const u = e.usage;
        await waicc($, ["turn", JSON.stringify({
          chatId: `claude-${await $.session.id()}`, model: u?.model ?? (await $.session.model()), ms: e.durationMs, outcome: e.reason,
          ...(current ? { sessionId: current } : {}),
          ...(u ? { usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens } } : {}),
        })]);
      } catch { /* the log never stands in the way of the turn */ }
      await update($, request, () => null);
      // After the turn has ended, not inside it.
      $.clock.after(0, () => void openPicker($).then(() => afterLoopTurn($)));
    }
    return result;
  }).catch(($, e, next) => next(e));

  on("prompt.compose", async ($, e, next) => {
    const composed = await next(e);
    return { sections: [...composed.sections, { id: "waicc:session", text: waiccSection(await bound($)), scope: "session" as const }] };
  });
};
