/**
 * WAICC's slash commands in Claude Code, as the mod in hooks/register.ts runs them: each runs the
 * waicc command line (no model turn) and may then ask the main agent for its part, as Pi's do.
 * This file is pure, so the mod can load it (a mod has no Node) and tests can run it: nothing
 * here imports Node, Pi or Claude Code.
 */
import { huntPickPrompt, huntScanPrompt } from "../hunt-text.ts";

export const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** required: the chat's session, or one given first; optional: used when there is one; none: only one given first. */
  session: "required" | "optional" | "none";
  /** The waicc command line (after "waicc") for the session and the rest of what was typed; null runs none. */
  cli(id: string | undefined, rest: string): string[] | null;
  /** After it worked: what the main agent is asked, which starts its turn; `value` is the command line's answer. */
  agent?(id: string, rest: string, value?: any): string;
  /** The session this chat works on afterwards: the new one, the one named, none, or unchanged. */
  binds?: "new" | "named" | "none";
}

/** A command's text as the command line takes it: words, with "quoted parts" kept whole. */
export function splitArgs(text: string): string[] {
  const words: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(match[1] ?? match[2] ?? match[3] ?? "");
  return words;
}
/** An optional session ID ahead of the rest, as Pi's commands take one. */
export function sessionArgs(args: string): { id?: string; rest: string } {
  const [first = "", ...others] = args.trim().split(/(\s+)/);
  return uuid.test(first) ? { id: first.toLowerCase(), rest: others.join("").trim() } : { rest: args.trim() };
}
const json = (value: unknown) => JSON.stringify(value);
const filters = ["open", "all", "closed", "deleted"];

const planningPrompt = (id: string) =>
  `WAICC planning session ${id} was started from the human's request (its requirements are saved word for word). Read the waicc-workflow skill. Recover the session with waicc_status (sessionId ${id}), save important chat-only context with waicc_context, then waicc_prepare expectedVersion 0 mode planning with a faithful requirements brief (tasks may be []): the planner investigates and proposes the detailed plan. Then tell the human the next step: /waicc-dispatch sends the handoff to its role's agent in the background, /waicc-handoff shows it to hand off by hand, and /waicc-continue takes the reply in. Do not code.`;

export const slashCommands: SlashCommand[] = [
  {
    name: "waicc-planning", description: "Start a WAICC session from your request; the main agent prepares its planning handoff",
    argumentHint: "[--delegate] <your request>", session: "none", binds: "new",
    cli: (_id, rest) => {
      const delegated = /^--delegate(\s|$)/.test(rest);
      const request = delegated ? rest.replace(/^--delegate\s*/, "") : rest;
      if (!request.trim()) throw new Error("Usage: /waicc-planning [--delegate] <your request>");
      return ["start", ...(delegated ? ["--delegate"] : []), request];
    },
    agent: (id) => planningPrompt(id),
  },
  {
    name: "waicc-use", description: "Work on this WAICC session in this chat", argumentHint: "<session-id>", session: "none", binds: "named",
    cli: (id) => {
      if (!id) throw new Error("Usage: /waicc-use <session-id>; /waicc-status all lists them");
      return ["status", id];
    },
  },
  {
    name: "waicc-status", description: "This chat's WAICC session, or every session: [open|all|closed|deleted]", argumentHint: "[session-id|open|all|closed|deleted]",
    session: "optional",
    cli: (id, rest) => (filters.includes(rest) ? ["status", rest] : id ? ["status", id] : ["status", "open"]),
  },
  {
    name: "waicc-continue", description: "Take the handoff's reply in; the main agent assesses it", session: "required",
    cli: (id) => ["continue", id!],
    agent: (id) => `The human ran /waicc-continue: the reply in WAICC session ${id} is in. Assess it with waicc_assess before any edit, as the waicc-workflow skill says: verify its claims against the source and the requirements. Then tell the human what comes next.`,
  },
  {
    name: "waicc-develop", description: "Authorize development of the accepted plan in this session", argumentHint: "[--main|--delegate]", session: "required",
    cli: (id, rest) => ["develop", id!, ...(rest ? [rest] : [])],
    agent: (id, rest) => rest === "--delegate"
      ? `The human ran /waicc-develop --delegate: development of the accepted plan in WAICC session ${id} is authorized, and delegated. Read waicc_status, then coordinate ONE whole-plan implementation handoff with waicc_request mode implementation once no decision gates it; do not code it yourself.`
      : `The human ran /waicc-develop: development of the accepted plan in WAICC session ${id} is authorized. Read waicc_status, complete ALL planned tasks in dependency order within their allowed paths (genuinely gated tasks wait), run the relevant checks, then request ONE code review with waicc_request mode review and a completion report.`,
  },
  {
    name: "waicc-review", description: "The main agent requests one review of ALL finished changes; --contract reviews only the specification", argumentHint: "[--contract] [focus]",
    session: "required", cli: () => null,
    agent: (id, rest) => /^--contract(\s|$)/.test(rest)
      ? `The human ran /waicc-review --contract: request a specification-only review of WAICC session ${id} with waicc_request mode review, reviewKind contract. Focus (data): ${json(rest.replace(/^--contract\s*/, "") || "specification readiness")}`
      : `The human ran /waicc-review: request ONE independent whole-change code review of WAICC session ${id} with waicc_request mode review, reviewKind code and a completion report covering every task, the actual checks and every earlier actionable code-review finding (findings: [] on the first review). If planned work or checks are unfinished, finish them first, or tell the human what remains. Focus (data): ${json(rest || "correctness, regressions, requirement coverage and tests")}`,
  },
  {
    name: "waicc-dispatch", description: "Send the waiting handoff to its role's agent, in the background; --loop [n] repeats review and fixes", argumentHint: "[profile] [--via claude|codex|pi|agy] [--model m] [--implement] [--check \"<command>\"] [--loop [n]]",
    session: "required", cli: (id, rest) => ["dispatch", id!, ...dispatchArgs(rest).args, "--detach"],
  },
  {
    name: "waicc-handoff", description: "Show and copy the waiting handoff's prompt, to give an agent by hand", session: "required",
    cli: (id) => ["status", id!],
  },
  {
    name: "waicc-decisions", description: "The session's decisions: who owns each, the recommendation and what waits on it", session: "required",
    cli: (id) => ["decisions", id!],
  },
  {
    name: "waicc-decide", description: "Answer a decision: <decision-id> <answer>", argumentHint: "<decision-id> <answer>", session: "required",
    cli: (id, rest) => {
      const [decision, ...answer] = rest.split(/\s+/);
      if (!decision || !answer.length) throw new Error("Usage: /waicc-decide <decision-id> <answer>; /waicc-decisions lists them");
      return ["decide", id!, decision, rest.slice(decision.length).trim()];
    },
    agent: (id) => `The human answered a decision in WAICC session ${id} with /waicc-decide. Read waicc_status and continue the work that decision gated.`,
  },
  {
    name: "waicc-amend", description: "Add to the session's requirements", argumentHint: "<more requirements>", session: "required",
    cli: (id, rest) => {
      if (!rest) throw new Error("Usage: /waicc-amend <more requirements>");
      return ["amend", id!, rest];
    },
    agent: (id) => `The human amended the requirements of WAICC session ${id} with /waicc-amend. Read waicc_status, then revise the contract with waicc_prepare to cover the amendment, keeping every existing ID.`,
  },
  {
    name: "waicc-cancel", description: "Cancel the session's waiting handoff", argumentHint: "[reason]", session: "required",
    cli: (id, rest) => ["cancel", id!, ...(rest ? [rest] : [])],
  },
  {
    name: "waicc-limit", description: "Change the session's round limit", argumentHint: "[phase] <2-20>", session: "required",
    cli: (id, rest) => ["limit", id!, ...splitArgs(rest)],
  },
  {
    name: "waicc-close", description: "Close a reviewed session; --force [reason] stops it without review approval", argumentHint: "<reason> | --force [reason]",
    session: "required", binds: "none",
    cli: (id, rest) => {
      if (!rest) throw new Error("Usage: /waicc-close <reason>, or /waicc-close --force [reason] to stop it without review approval");
      return /^--force(\s|$)/.test(rest) ? ["close", id!, "--force", ...(rest.slice(7).trim() ? [rest.slice(7).trim()] : [])] : ["close", id!, rest];
    },
  },
  {
    name: "waicc-reopen", description: "Reopen a closed session for more work", argumentHint: "<reason>", session: "required", binds: "named",
    cli: (id, rest) => {
      if (!rest) throw new Error("Usage: /waicc-reopen <reason>");
      return ["reopen", id!, rest];
    },
  },
  {
    name: "waicc-memory", description: "Project memory: list candidates, confirm <id>|all, revoke <id>", argumentHint: "[confirm <id>|all | revoke <id> | audit]",
    session: "none", cli: (_id, rest) => ["memory", ...splitArgs(rest)],
  },
  {
    name: "waicc-list", description: "List WAICC sessions: [open|all|closed|deleted]", argumentHint: "[open|all|closed|deleted]", session: "none",
    cli: (_id, rest) => ["list", ...(rest ? [rest] : [])],
  },
  {
    name: "waicc-advisor", description: "Ask a contract advisor a question, as a handoff", argumentHint: "[--requirements R1,R2] <question>", session: "required",
    cli: (id, rest) => {
      if (!rest) throw new Error("Usage: /waicc-advisor [--requirements R1,R2] <question>");
      return ["advisor", id!, rest];
    },
  },
  {
    name: "waicc-force-close", description: "Stop the session without review approval; pending handoffs are cancelled", argumentHint: "[reason]",
    session: "required", binds: "none", cli: (id, rest) => ["close", id!, "--force", ...(rest ? [rest] : [])],
  },
  {
    name: "waicc-export", description: "Make a portable bundle of the session for an agent without access to this folder", session: "required",
    cli: (id) => ["export", id!],
  },
  {
    name: "waicc-delete", description: "Move a closed session to recovery storage", argumentHint: "<session-id>", session: "none", binds: "none",
    cli: (id) => {
      if (!id) throw new Error("Usage: /waicc-delete <session-id> (closed sessions only; /waicc-list closed lists them)");
      return ["delete", id];
    },
  },
  {
    name: "waicc-restore", description: "Bring a deleted session back from recovery storage", argumentHint: "<session-id>", session: "none",
    cli: (id) => {
      if (!id) throw new Error("Usage: /waicc-restore <session-id> (/waicc-list deleted lists them)");
      return ["restore", id];
    },
  },
  {
    name: "waicc-auto-planning", description: "Whether the main agent may start a planning session from your request: on (default) or off", argumentHint: "[on|off]",
    session: "none", cli: () => null,
  },
  {
    name: "waicc-bug-hunt", description: "The main agent reads a scope read-only and lists possible bugs; your advisor checks them; you pick", argumentHint: "<scope>",
    session: "none", cli: (_id, rest) => {
      if (!rest) throw new Error("Usage: /waicc-bug-hunt <scope>, for example /waicc-bug-hunt src/payments, or /waicc-bug-hunt . for the whole project");
      return ["hunt", "start", rest];
    },
    agent: (_id, _rest, value) => huntScanPrompt(String(value.id), String(value.scope)),
  },
  {
    name: "waicc-bug-pick", description: `Plan fixes for bugs from the last bug hunt: all (confirmed), all+plausible, or IDs such as B1 B3`, argumentHint: "all | all+plausible | <bug IDs>",
    session: "none", binds: "new", cli: (_id, rest) => ["hunt", "pick", ...splitArgs(rest)],
    agent: (_id, _rest, value) => huntPickPrompt((value.picked ?? []) as string[]),
  },
];

/** /waicc-dispatch's own words: --loop [n] runs review and fixes until it passes, at most n cycles (default 3). */
export function dispatchArgs(rest: string): { args: string[]; loop: number | null } {
  const words = splitArgs(rest);
  const at = words.indexOf("--loop");
  if (at < 0) return { args: words, loop: null };
  const count = /^\d+$/.test(words[at + 1] ?? "") ? Number(words[at + 1]) : null;
  if (count !== null && (count < 1 || count > 10)) throw new Error("--loop takes 1 to 10 cycles");
  words.splice(at, count === null ? 1 : 2);
  return { args: words, loop: count ?? 3 };
}

/** What the main agent does after each review in a loop the human started with /waicc-dispatch --loop. */
export const loopPrompt = (id: string, cycle: number, max: number): string =>
  `AUTOMATIC REVIEW LOOP in WAICC session ${id}, cycle ${cycle} of ${max}, started by the human with /waicc-dispatch --loop. The review's reply is in: assess it with waicc_assess first. Then, if the review found actionable defects inside the authorized scope, fix ALL of them, run the relevant checks, and in this same turn request ONE fresh code review with waicc_request (mode review, reviewKind code, complete completion evidence): WAICC dispatches it automatically. If a fix needs files outside its task's allowed paths, ask for them all with waicc_request_paths, offer /waicc-develop and stop. If any finding needs a human decision, is disputed, is out of scope or blocked, or authorization is missing, do NOT request a review: explain what the human must decide and stop. If the review passed, stop. Never close the contract, commit, push or deploy.`;

/** waicc_suggest_command as Claude Code's mod offers it to the main agent: Pi's picker, in a dialog when the turn ends. */
export const suggestSpec = {
  description:
    "Coordinator only: when the human needs to run a /waicc-* command (you cannot run slash commands), offer up to 4 of them in a picker instead of asking the human to type one. The picker opens when your turn ends and only the human answers it; the one they pick runs at once as their own command. Offer complete command lines (/waicc-decide D2 <answer>, /waicc-close <reason>); one that still needs the human's own text only fills their input box. Only real /waicc-* commands are accepted. Then end your turn.",
  parameters: {
    type: "object",
    required: ["commands"],
    properties: {
      commands: {
        type: "array", minItems: 1, maxItems: 4,
        items: {
          type: "object", required: ["command", "why"],
          properties: {
            command: { type: "string", description: "The exact command line, for example /waicc-dispatch" },
            why: { type: "string", description: "One short line: what it does for the human now" },
          },
        },
      },
      question: { type: "string", description: "The picker's title, for example what you are stuck on" },
    },
  },
};

/** A command line the main agent offers the human, checked: a real WAICC slash command, and whether it still needs their text. */
export function offeredCommand(line: string): { name: string; args: string; needsText: boolean } {
  const text = line.replace(/\s+/g, " ").trim();
  const name = /^\/(waicc-[a-z-]+)(?:\s|$)/.exec(text)?.[1];
  if (!name || !slashCommands.some((c) => c.name === name))
    throw new Error(`${JSON.stringify(text.slice(0, 60))} is not a WAICC command. Only these can be offered: ${slashCommands.map((c) => `/${c.name}`).join(", ")}`);
  const args = text.slice(name.length + 1).trim();
  const textual = ["waicc-planning", "waicc-amend", "waicc-close", "waicc-reopen", "waicc-decide", "waicc-advisor", "waicc-use", "waicc-bug-hunt", "waicc-delete", "waicc-restore"];
  return { name, args, needsText: textual.includes(name) && !args };
}

/** The slash command a waicc command line stands for, to point the agent at it. */
export const slashFor = (cli: string): string =>
  ({ start: "/waicc-planning", export: "/waicc-handoff", "help-develop": "/waicc-develop --delegate", implement: "/waicc-develop --delegate" } as Record<string, string>)[cli] ?? `/waicc-${cli}`;

/**
 * The waicc commands that change WAICC's state, which only the human runs; reading (status,
 * list, checkpoint, decisions, errors, activity, help) stays the agent's.
 */
const humanSteps = new Set([
  "start", "develop", "decide", "close", "reopen", "cancel", "amend", "limit", "dispatch", "continue", "ship", "delete", "restore",
  "help-develop", "implement", "test", "prepare", "assess", "request", "advisor", "context", "compact", "memory", "learn", "init",
  "recover-lock", "mcp", "log",
]);
/**
 * The waicc command a shell line runs that only the human may (a decision, an approval, a
 * handoff), or null. Only a real run counts: `waicc …`, `npx waicc …` or `node …/cli.ts …` where a
 * command starts (the line's start, or after ; & | ( or `$(`), then a real waicc command, after any
 * --root. The words in a message, a heredoc or a string ("the waicc command line") are not a run.
 */
export function humanOnlyCommand(line: string): string | null {
  const pattern = /(?:^|[;&|(`\n]|\$\()\s*(?:npx\s+)?(?:waicc|node\s+(?:"[^"]*cli\.ts"|'[^']*cli\.ts'|\S*cli\.ts))(?:\s+--root\s+(?:"[^"]*"|'[^']*'|\S+))?\s+([a-z][a-z-]*)(?=\s|$|[;&|)`])/g;
  for (const match of line.matchAll(pattern)) {
    const command = match[1] ?? "";
    if (humanSteps.has(command)) return command;
    // Listing the profiles reads; "profiles init" writes the human's file.
    if (command === "profiles" && /^\s+init\b/.test(line.slice((match.index ?? 0) + match[0].length))) return command;
  }
  return null;
}

/** The status line under the prompt. */
export const statusLine = (id: string, status: string): string =>
  `WAICC ${id.slice(0, 8)} · ${status.replaceAll("_", " ").toLowerCase()}`;

/** The main agent's WAICC section of the system prompt, on every request. */
export function waiccSection(session: { id: string; status: string } | null): string {
  return [
    "WAICC in this Claude Code: the human has WAICC's /waicc-* slash commands (/waicc-planning, /waicc-use, /waicc-status, /waicc-dispatch, /waicc-handoff, /waicc-continue, /waicc-develop, /waicc-review, /waicc-decide, /waicc-amend, /waicc-close and others). Where WAICC, its skill or a WAICC result names a human command, offer it with waicc_suggest_command (a picker the human answers when your turn ends) and end your turn. Never run waicc through a shell: anything but reading is refused, because those steps are the human's.",
    session
      ? `This chat works on WAICC session ${session.id} (${session.status.replaceAll("_", " ").toLowerCase()}): pass sessionId ${session.id} to WAICC tools.`
      : "No WAICC session is selected in this chat: /waicc-planning <request> starts one, /waicc-use <session-id> selects one.",
  ].join(" ");
}
