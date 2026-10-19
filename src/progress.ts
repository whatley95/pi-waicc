import { basename, isAbsolute, relative } from "node:path";
import type { Agent } from "./dispatch.ts";

/** One readable step of a dispatched agent's work, from its own event stream. */
export interface ProgressEvent {
  /** Milliseconds since the agent started. */
  at: number;
  kind: "step" | "note" | "waicc" | "rejected";
  text: string;
}

const oneLine = (text: string, max = 140): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What a tool call is doing, in plain words. Unknown tools still show their name. */
function describe(tool: string, input: Record<string, unknown>, shorten: (path: string) => string): Omit<ProgressEvent, "at"> | null {
  const name = tool.replace(/^mcp__waicc__/, "");
  const path = typeof (input.file_path ?? input.path) === "string" ? shorten(String(input.file_path ?? input.path)) : "";
  switch (name) {
    case "waicc_receive": return { kind: "waicc", text: "Received the assignment" };
    case "waicc_assignment": case "waicc_status": return { kind: "waicc", text: "Re-reading the assignment" };
    case "waicc_read_input": return { kind: "waicc", text: `Reading the handoff's ${basename(String(input.path ?? "input"))}` };
    case "waicc_run_check": return { kind: "waicc", text: `Running approved check ${String(input.check ?? "")}`.trim() };
    case "waicc_check": return { kind: "waicc", text: `Running approved check: ${oneLine([input.program, ...(Array.isArray(input.args) ? input.args : [])].join(" "), 80)}` };
    case "waicc_validate_reply": return { kind: "waicc", text: "Validating the draft reply" };
    case "waicc_submit_reply": return { kind: "waicc", text: "Submitting the reply" };
    case "waicc_reply": return { kind: "waicc", text: input.validateOnly ? "Validating the draft reply" : "Submitting the reply" };
    case "Read": case "read": return { kind: "step", text: `Reading ${path || "a file"}` };
    case "Grep": case "grep": return { kind: "step", text: `Searching for ${JSON.stringify(oneLine(String(input.pattern ?? ""), 60))}${path ? ` in ${path}` : ""}` };
    case "Glob": case "find": return { kind: "step", text: `Finding files ${JSON.stringify(oneLine(String(input.pattern ?? input.glob ?? ""), 60))}` };
    case "ls": case "LS": return { kind: "step", text: `Listing ${path || "a folder"}` };
    case "Edit": case "edit": case "MultiEdit": return { kind: "step", text: `Editing ${path || "a file"}` };
    case "Write": case "write": return { kind: "step", text: `Writing ${path || "a file"}` };
    case "Bash": case "bash": return { kind: "step", text: `Running ${oneLine(String(input.command ?? ""), 100)}` };
    case "TodoWrite": return null;
    case "ToolSearch": return { kind: "step", text: "Loading its tools" };
    default: return { kind: "step", text: `Using ${name}` };
  }
}

/** Codex wraps commands in a shell invocation; show the command itself. */
const unwrapShell = (command: string): string =>
  command.match(/-Command\s+"([\s\S]*)"\s*$/)?.[1] ?? command.match(/-lc\s+'([\s\S]*)'\s*$/)?.[1] ?? command;

/**
 * Turns one agent's streamed JSON lines into progress events. Unrecognised lines are ignored,
 * so a format change degrades to fewer updates, never to a failed dispatch.
 */
export function progressParser(via: Agent, cwd: string, startedAt = Date.now()) {
  const shorten = (path: string): string => {
    const inside = (isAbsolute(path) ? relative(cwd, path) : path).replaceAll("\\", "/");
    const shown = inside && !inside.startsWith("..") ? inside : path.replaceAll("\\", "/");
    // The handoff's own files live deep in WAICC's state folder; name them, not their path.
    const handoff = /\.pi\/pi-waicc\/sessions\/[^/]+\/(?:rounds\/[^/]+\/)?(.+)$/.exec(shown);
    return handoff ? `the handoff's ${handoff[1]}` : shown;
  };
  const tools = new Map<string, string>();
  const event = (part: Omit<ProgressEvent, "at"> | null): ProgressEvent[] => (part ? [{ at: Date.now() - startedAt, ...part }] : []);
  const note = (text: unknown): ProgressEvent[] => (typeof text === "string" && text.trim() ? event({ kind: "note", text: oneLine(text) }) : []);
  const rejected = (tool: string | undefined, text: unknown): ProgressEvent[] =>
    tool && /validate_reply|submit_reply|waicc_reply|run_check|waicc_check|receive/.test(tool)
      ? event({ kind: "rejected", text: `${/run_check|waicc_check/.test(tool) ? "Check refused" : "Draft rejected"}: ${oneLine(typeof text === "string" ? text : JSON.stringify(text ?? ""), 160)}` })
      : [];

  return (line: string): ProgressEvent[] => {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      return [];
    }
    if (!j || typeof j !== "object") return [];
    switch (via) {
      case "claude": {
        const content = j.message?.content;
        if (!Array.isArray(content)) return [];
        if (j.type === "assistant")
          return content.flatMap((part: any) => {
            if (part.type === "tool_use") {
              tools.set(part.id, part.name);
              return event(describe(part.name, part.input ?? {}, shorten));
            }
            return part.type === "text" ? note(part.text) : [];
          });
        if (j.type === "user")
          return content.flatMap((part: any) =>
            part.type === "tool_result" && part.is_error ? rejected(tools.get(part.tool_use_id), Array.isArray(part.content) ? part.content.map((c: any) => c.text).join(" ") : part.content) : []);
        return [];
      }
      case "codex": {
        const item = j.item;
        if (!item) return [];
        if (j.type === "item.started" && item.type === "command_execution") return event({ kind: "step", text: `Running ${oneLine(unwrapShell(String(item.command ?? "")), 100)}` });
        if (j.type === "item.started" && item.type === "mcp_tool_call") return event(describe(String(item.tool), item.arguments ?? {}, shorten));
        if (j.type === "item.completed" && item.type === "mcp_tool_call" && (item.error || item.result?.isError))
          return rejected(String(item.tool), item.error ?? item.result?.content?.map((c: any) => c.text).join(" "));
        if (j.type === "item.started" && item.type === "file_change")
          return event({ kind: "step", text: `Editing ${(item.changes ?? []).map((c: any) => shorten(String(c.path))).join(", ") || "files"}` });
        if (j.type === "item.completed" && item.type === "agent_message") return note(item.text);
        if (j.type === "item.completed" && item.type === "reasoning") return note(item.text);
        return [];
      }
      case "pi": {
        if (j.type === "tool_execution_start") {
          tools.set(j.toolCallId, j.toolName);
          return event(describe(String(j.toolName), j.args ?? {}, shorten));
        }
        if (j.type === "tool_execution_end" && (j.isError || j.result?.isError))
          return rejected(String(j.toolName), j.result?.content?.map((c: any) => c.text).join(" "));
        if (j.type === "message_end" && j.message?.role === "assistant" && Array.isArray(j.message.content))
          return j.message.content.flatMap((part: any) => (part.type === "text" ? note(part.text) : []));
        return [];
      }
      default: {
        // Antigravity's stream is not verified: take any tool-shaped event, best effort.
        const name = j.tool_name ?? j.toolName ?? j.name ?? j.tool?.name;
        if (typeof name === "string" && /tool/i.test(String(j.type ?? ""))) return event(describe(name, j.input ?? j.args ?? j.arguments ?? {}, shorten));
        return typeof j.text === "string" && /message|text/i.test(String(j.type ?? "")) ? note(j.text) : [];
      }
    }
  };
}

/** A short "1m 05s" style elapsed time. */
export function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
