import { createInterface } from "node:readline";
import {
  assignmentText,
  receiveHandoff,
  recipientAssignment,
  submitRecipientReply,
  validateRecipientReply,
} from "./recipient.ts";
import { ensure, identifier } from "./validation.ts";
import type { RecipientPin } from "./types.ts";

/** Newest first; an unknown client version gets the newest one we implement. */
const protocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const serverVersion = "0.1.0";

export interface McpOptions {
  /** Dispatch pins one request; the server then refuses to receive anything else. */
  sessionId?: string;
  requestId?: string;
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
  const call = (name: string, args: Record<string, unknown>): string => {
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
        // Implementation edits cannot be confined to task paths outside Pi.
        const assignment = receiveHandoff(cwd, sessionId, false);
        ensure(
          assignment.pin.requestId === requestId,
          "The session's waiting request is not the one in your handoff. Stop and return to the coordinator.",
        );
        pin = assignment.pin;
        return assignmentText(assignment);
      }
      case "waicc_assignment":
        return assignmentText(recipientAssignment(cwd, pinned()));
      case "waicc_validate_reply":
        return JSON.stringify(validateRecipientReply(cwd, pinned(), args.reply), null, 2);
      case "waicc_submit_reply":
        return JSON.stringify(submitRecipientReply(cwd, pinned(), args.reply), null, 2);
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  };
  /** One JSON-RPC message in, at most one response out (notifications get none). */
  return (message: Message): object | undefined => {
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
          return respond({ content: [{ type: "text", text: call(name, args) }] });
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
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
      return;
    }
    const response = handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  return new Promise((resolve) => lines.on("close", resolve));
}
