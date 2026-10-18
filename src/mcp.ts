import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  assignmentText,
  receiveHandoff,
  recipientAssignment,
  submitRecipientReply,
  validateRecipientReply,
} from "./recipient.ts";
import { runRecipientCheck, type CheckCommand } from "./checks.ts";
import { commandText, maxCheckMs, runAgent } from "./dispatch.ts";
import { projectRoot, snapshot } from "./source.ts";
import { ensure, identifier } from "./validation.ts";
import type { RecipientPin } from "./types.ts";

/** Newest first; an unknown client version gets the newest one we implement. */
const protocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const serverVersion = "0.1.0";

export interface McpOptions {
  /** Dispatch pins one request; the server then refuses to receive anything else. */
  sessionId?: string;
  requestId?: string;
  /** Isolated-worktree dispatch only: the agent edits a copy, and WAICC checks scope before applying. */
  implement?: boolean;
  /** Exact commands the human pre-approved when dispatching; nothing else can be run. */
  checks?: CheckCommand[];
  /** Where checks run: the isolated worktree of an isolated implementation. */
  checkCwd?: string;
}

const replySchema = {
  type: "object",
  properties: {
    reply: {
      type: "object",
      description:
        "Reply body from the assignment's replyTemplate: outcome, summary, coverage, findings, questions, checks and optional proposedContract/advice. Pinned identity fields are added by WAICC.",
    },
  },
  required: ["reply"],
};
const tools = [
  {
    name: "waicc_receive",
    description:
      "Recipient only: pin this agent to the session's single waiting WAICC handoff and return its assignment. Call first. Read-only roles only (planning, review, advisor, testing); implementation stays in Pi /waicc-receive --implement. Never retargets to a different request.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "WAICC session ID from the handoff prompt" },
        requestId: { type: "string", description: "Request ID from the handoff prompt; refuses any other request" },
      },
      required: ["sessionId", "requestId"],
    },
  },
  {
    name: "waicc_assignment",
    description:
      "Re-read the pinned assignment: exact contract, requirements, saved context, conversation, skills, reply template and input paths.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "waicc_read_input",
    description:
      "Read one of the pinned assignment's input files (any path listed in its inputs or skills), in chunks. Use this when those files are outside your workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Exact path from the assignment's inputs or skills" },
        offset: { type: "integer", description: "Character offset for the next chunk; default 0" },
      },
      required: ["path"],
    },
  },
  {
    name: "waicc_run_check",
    description:
      "Run one check the human pre-approved for this dispatch, by its number in the list waicc_receive returned. WAICC runs the exact command, logs its output and source state, and returns the result to cite in your reply. No other command can be run.",
    inputSchema: {
      type: "object",
      properties: { check: { type: "integer", description: "Number of the pre-approved check" } },
      required: ["check"],
    },
  },
  {
    name: "waicc_validate_reply",
    description:
      "Dry run: apply every submit-time check to a draft reply without writing it. Fix any reported problem, then submit once.",
    inputSchema: replySchema,
  },
  {
    name: "waicc_submit_reply",
    description:
      "Validate and write the one reply for the pinned request. Does not assess or advance the contract. Stop after a successful submission and tell the human to run /waicc-continue in the coordinator.",
    inputSchema: replySchema,
  },
];

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export function mcpServer(cwd: string, options: McpOptions = {}) {
  let pin: RecipientPin | undefined;
  const pinned = (): RecipientPin => {
    ensure(pin, "Call waicc_receive with the handoff's sessionId and requestId first");
    return pin;
  };
  const approved = (): string =>
    options.checks?.length
      ? `\n\nPre-approved checks, run with waicc_run_check by number:\n${options.checks.map((check, i) => `${i}: ${commandText(check)}`).join("\n")}`
      : "";
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case "waicc_receive": {
        const sessionId = identifier(args.sessionId, "Session ID");
        const requestId = identifier(args.requestId, "Request ID");
        ensure(
          (!options.sessionId || options.sessionId === sessionId) &&
            (!options.requestId || options.requestId === requestId),
          "This WAICC server was started for a different request. Stop; do not retarget.",
        );
        ensure(
          !pin || (pin.sessionId === sessionId && pin.requestId === requestId),
          "This agent is already pinned to another request. Stop; do not retarget.",
        );
        // Edits by an external agent cannot be confined to task paths, except in an isolated
        // copy whose changes WAICC checks before applying them.
        const assignment = receiveHandoff(cwd, sessionId, options.implement === true);
        ensure(
          assignment.pin.requestId === requestId,
          "The session's waiting request is not the one in your handoff. Stop and return to the coordinator.",
        );
        pin = assignment.pin;
        return assignmentText(assignment) + approved();
      }
      case "waicc_assignment":
        return assignmentText(recipientAssignment(cwd, pinned())) + approved();
      case "waicc_run_check": {
        const checks = options.checks ?? [];
        ensure(checks.length, "No checks were pre-approved for this dispatch; report checks not_run with that limit.");
        const index = Number(args.check);
        ensure(Number.isInteger(index) && index >= 0 && index < checks.length, `check must be a number from 0 to ${checks.length - 1}`);
        const source = snapshot(projectRoot(cwd)).fingerprint;
        const result = await runRecipientCheck(cwd, pinned(), checks[index], source, runAgent, undefined, { maxTimeoutMs: maxCheckMs, workdir: options.checkCwd });
        return JSON.stringify(result, null, 2);
      }
      case "waicc_read_input": {
        const assignment = recipientAssignment(cwd, pinned());
        const allowed = [...Object.values(assignment.inputs), ...assignment.skills].filter((path): path is string => typeof path === "string");
        ensure(allowed.includes(String(args.path)), "Only paths listed in the assignment's inputs or skills can be read");
        const offset = Number(args.offset ?? 0);
        ensure(Number.isInteger(offset) && offset >= 0, "offset must be a non-negative integer");
        const text = readFileSync(String(args.path), "utf8");
        const chunk = text.slice(offset, offset + 60_000);
        const next = offset + chunk.length;
        return next < text.length ? `${chunk}
[Truncated: call waicc_read_input again with offset ${next} of ${text.length}.]` : chunk;
      }
      case "waicc_validate_reply":
        return JSON.stringify(validateRecipientReply(cwd, pinned(), args.reply), null, 2);
      case "waicc_submit_reply":
        return JSON.stringify(submitRecipientReply(cwd, pinned(), args.reply), null, 2);
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  };
  /** One JSON-RPC message in, at most one response out (notifications get none). */
  return async (message: Message): Promise<object | undefined> => {
    const respond = (result: object) => ({ jsonrpc: "2.0", id: message.id, result });
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id: message.id ?? null, error: { code, message: text } });
    if (message.id === undefined) return undefined;
    switch (message.method) {
      case "initialize": {
        const requested = String(message.params?.protocolVersion ?? "");
        return respond({
          protocolVersion: protocolVersions.includes(requested) ? requested : protocolVersions[0],
          capabilities: { tools: {} },
          serverInfo: { name: "waicc", version: serverVersion },
          instructions:
            "WAICC recipient tools. Call waicc_receive with the sessionId and requestId from your handoff prompt, do only that assignment, check your draft with waicc_validate_reply, submit once with waicc_submit_reply, then stop. Never write reply.json with generic file tools when these tools are available.",
        });
      }
      case "ping":
        return respond({});
      case "tools/list":
        return respond({ tools });
      case "tools/call": {
        const name = String(message.params?.name ?? "");
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        if (!tools.some((tool) => tool.name === name)) return fail(-32602, `Unknown tool ${name}`);
        // Tool failures are results the model can read and correct, not protocol errors.
        try {
          return respond({ content: [{ type: "text", text: await call(name, args) }] });
        } catch (error) {
          return respond({
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          });
        }
      }
      default:
        return fail(-32601, `Method not found: ${message.method}`);
    }
  };
}

/** Newline-delimited JSON-RPC over stdio. stdout carries protocol messages only. */
export function serveMcp(cwd: string, options: McpOptions = {}): Promise<void> {
  const handle = mcpServer(cwd, options);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Calls may finish out of order (a check runs long); JSON-RPC matches responses by id.
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      return;
    }
    const response = await handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  return new Promise((resolve) => lines.on("close", resolve));
}
