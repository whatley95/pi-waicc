import { randomBytes } from "node:crypto";
import { argumentShape, recordError } from "./error-log.ts";
import { newFlow, recordActivity } from "./activity-log.ts";
import { checkpointView } from "./checkpoint.ts";
import { consultAdvisor } from "./consult.ts";
import { adviceText, advisorContext, advisorTurn, agentText, applyPolicy, assessReply, prepareHandoff, proposeLesson, proposeMemory, refusalNudge, requestHandoff, rereadTools, stepView, type Outcome } from "./coordinator.ts";
import { runAgent, type AgentRunner } from "./dispatch.ts";
import { listSessions, loadSession } from "./files.ts";
import { contractOwner, decisionFormat, sourceFirst } from "./instructions.ts";
import { recall } from "./memory.ts";
import { consultSettings, decisionSettings, policyGuidance, profilesBrief } from "./profiles.ts";
import { huntTable, reportBugs, triageBugs } from "./hunt.ts";
import { projectRoot } from "./source.ts";
import {
  askAdvisorSpec, applyPolicySpec, assessSpec, checkpointSpec, contextSpec, learnPatternSpec, memorySpec, prepareSpec, reportBugsSpec, requestSpec, statusSpec,
  type ApplyPolicyParams, type AskAdvisorParams, type AssessParams, type ContextParams, type LearnPatternParams, type MemoryParams,
  type PrepareParams, type ReportBugsParams, type RequestParams, type SessionParams, type ToolSpec,
} from "./tool-specs.ts";
import { decodeJsonArguments, ensure } from "./validation.ts";
import { saveContext, status } from "./workflow.ts";

/**
 * The main agent's WAICC tools over MCP, for a host other than Pi (Claude Code first). The tools
 * and what they do are Pi's own (src/tool-specs.ts, src/coordinator.ts); this adds what Pi's chat
 * gave them: the session this agent works on, its advisor questions and refused calls, and the
 * error and activity logs. One server process serves one host session.
 *
 * Human commands stay the human's: the host has no /waicc-* commands yet, so the instructions
 * name the WAICC CLI instead (`waicc develop <session>`, typed by the human).
 */
export const coordinatorSpecs: ToolSpec[] = [
  askAdvisorSpec, checkpointSpec, contextSpec, statusSpec, prepareSpec, assessSpec, learnPatternSpec, applyPolicySpec, requestSpec, memorySpec,
  reportBugsSpec,
];

/** How the agent tells the human to run a WAICC command, in a host without WAICC's slash commands. */
export const humanCommands = `You cannot run WAICC's human commands. Where your system prompt has a WAICC section saying the human has WAICC's /waicc-* slash commands (Claude Code's WAICC mod), tell them the slash command to type. Otherwise there are no /waicc-* slash commands here: where these instructions or a WAICC result name one, the human runs the WAICC command line instead, with the session ID after the command name: /waicc-develop is "waicc develop <session-id>", /waicc-decide D2 <answer> is "waicc decide <session-id> D2 <answer>", /waicc-close <reason> is "waicc close <session-id> <reason>", /waicc-continue is "waicc continue <session-id>", /waicc-dispatch is "waicc dispatch <session-id> [profile]", /waicc-handoff is "waicc export <session-id>", and /waicc-planning <request> is "waicc start <request>" (it prints the new session's ID). In Claude Code the human types such a line after "!" at the prompt (for example: ! waicc develop 1f0c…), which runs it without you. Give them the exact line, with the real session ID, and end your turn. Never run waicc commands yourself through a shell: they are the human's decisions. After the human ran "waicc continue", assess the reply with waicc_assess.`;

export function coordinatorInstructions(cwd: string): string {
  let policies = "";
  try {
    policies = policyGuidance(decisionSettings(cwd).policies);
  } catch { /* a broken settings file is reported by the profiles line */ }
  return [
    "WAICC coordinator tools: you are the owner of this project's WAICC contracts, handoffs and reviews. Read the waicc-workflow skill before using them.",
    humanCommands, contractOwner, sourceFirst, decisionFormat, policies, profilesBrief(cwd),
  ].filter(Boolean).join("\n\n");
}

export interface CoordinatorToolset {
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  instructions: string;
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export function coordinatorToolset(cwd: string, services: { runAgent?: AgentRunner } = {}): CoordinatorToolset {
  const root = projectRoot(cwd);
  // This server's host session, as the logs name a chat.
  const chat = `mcp-${randomBytes(4).toString("hex")}`;
  let bound: string | undefined;
  let advisorQuestions = 0, consulting = false, refused = 0;
  /** The session a call is about: the one it names (then this agent works on it), the last one named, or the only open one. */
  const session = (explicit?: string): string => {
    if (explicit) return (bound = explicit);
    if (bound) return bound;
    const open = listSessions(root).filter((s) => s.status !== "CLOSED").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    ensure(open.length, 'No open WAICC session in this project. The human starts one with: waicc start "<their request>"');
    ensure(open.length === 1, `Several WAICC sessions are open; pass sessionId. Open here, newest first: ${open.slice(0, 5).map((s) => `${s.id} (${s.status})`).join(", ")}`);
    return (bound = open[0].id);
  };
  /** The agent's text for an outcome, with what the human must be told: this host draws no notices. */
  const told = (outcome: Outcome) => {
    const human = [...outcome.notices.map((n) => n.text), ...outcome.messages];
    return `${agentText(outcome.result)}${human.length ? `\n\nTell the human:\n${human.map((line) => `- ${line}`).join("\n")}` : ""}`;
  };
  const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
    switch (name) {
      case "waicc_status":
        return agentText(status(cwd, session((args as SessionParams).sessionId)));
      case "waicc_checkpoint":
        return agentText(checkpointView(root, loadSession(root, session((args as SessionParams).sessionId))));
      case "waicc_context": {
        const params = args as unknown as ContextParams;
        const id = session(params.sessionId);
        saveContext(cwd, id, params.summary);
        return agentText(stepView(status(cwd, id)));
      }
      case "waicc_prepare": {
        const params = args as unknown as PrepareParams;
        session(params.sessionId);
        return told(prepareHandoff(cwd, params));
      }
      case "waicc_request": {
        const params = args as unknown as RequestParams;
        session(params.sessionId);
        return told(requestHandoff(cwd, params));
      }
      case "waicc_assess": {
        const params = args as unknown as AssessParams;
        session(params.sessionId);
        return told(assessReply(cwd, params));
      }
      case "waicc_apply_policy": {
        const params = args as unknown as ApplyPolicyParams;
        session(params.sessionId);
        return told(applyPolicy(cwd, params));
      }
      case "waicc_learn_pattern":
        return told(proposeLesson(cwd, args as unknown as LearnPatternParams));
      case "waicc_memory": {
        const params = args as unknown as MemoryParams;
        if (params.action === "recall") return agentText(recall(cwd, params.query));
        return agentText(proposeMemory(cwd, params, { sessionId: bound ?? null, model: null }));
      }
      case "waicc_ask_advisor": {
        const params = args as unknown as AskAdvisorParams;
        const turn = advisorTurn(cwd, advisorQuestions);
        ensure(!consulting, "The advisor is already answering a question in this chat; wait for it.");
        // Counted before it runs, so a failed or stopped consult still uses one.
        advisorQuestions++;
        consulting = true;
        try {
          const outcome = await consultAdvisor(cwd, { ...params, context: advisorContext(cwd, bound) }, turn.options, services.runAgent ?? runAgent);
          ensure(outcome.answer, `The advisor gave no answer (exit ${outcome.code}${outcome.killed ? ", stopped" : ""}). See ${outcome.log}. Continue on your own or ask the human.`);
          return adviceText(turn, { ...outcome, answer: outcome.answer });
        } finally {
          consulting = false;
        }
      }
      case "waicc_report_bugs": {
        const params = args as unknown as ReportBugsParams;
        reportBugs(cwd, params.huntId, params.bugs);
        // The human asked for this check, so it uses the advisor role even when asking it on its own is off.
        const settings = consultSettings(cwd);
        const advisor = settings.profile && settings.options ? { profile: settings.profile, options: settings.options } : null;
        const hunt = await triageBugs(cwd, params.huntId, advisor, services.runAgent ?? runAgent);
        return `${huntTable(hunt)}\n\nShow this table to the human as it is and stop. Do not start fixing or planning: the human picks with /waicc-bug-pick, and the picked bugs become a planning session.`;
      }
      default:
        throw new Error(`Unknown tool ${name}`);
    }
  };
  return {
    tools: coordinatorSpecs.map((spec) => ({ name: spec.name, description: spec.description, inputSchema: spec.parameters })),
    instructions: coordinatorInstructions(cwd),
    async call(name, raw) {
      const spec = coordinatorSpecs.find((tool) => tool.name === name);
      ensure(spec, `Unknown tool ${name}`);
      // Nested arguments may come as JSON text, as they may in Pi.
      const args = decodeJsonArguments(raw, spec.parameters);
      const flow = newFlow(), startedAt = Date.now();
      const sessionOf = () => (typeof args.sessionId === "string" ? args.sessionId : bound);
      let outcome = "ok";
      try {
        const text = await run(name, args);
        if (!rereadTools.has(name)) refused = 0;
        return { text, isError: false };
      } catch (error) {
        outcome = "error";
        const message = error instanceof Error ? error.message : String(error);
        try {
          recordError(root, name, message, { chat, args: argumentShape(args), sessionId: sessionOf(), flow });
        } catch { /* the log never stands in the way of the error */ }
        if (name !== "waicc_ask_advisor") refused++;
        return { text: `${message}${refusalNudge(cwd, refused, name, advisorQuestions)}`, isError: true };
      } finally {
        try {
          recordActivity(root, { flow, step: name, phase: "end", ms: Date.now() - startedAt, outcome, chat, sessionId: sessionOf() });
        } catch { /* the log never stands in the way of the tool */ }
      }
    },
  };
}
