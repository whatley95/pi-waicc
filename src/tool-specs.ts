import { huntLimit } from "./hunt-text.ts";

/**
 * The main agent's WAICC tools as any host offers them: name, what the model reads, and the
 * arguments as plain JSON Schema. Pi registers these (src/pi); an MCP server can list the same,
 * so the wording never drifts between hosts. No host's types or libraries are needed here.
 */
export interface ToolSpec {
  name: string;
  label: string;
  description: string;
  /** One line for a host that lists tools in its system prompt. */
  promptSnippet?: string;
  /** When to use the tool, for a host that adds tool guidelines to its system prompt. */
  promptGuidelines?: string[];
  parameters: JsonSchema;
}
export type JsonSchema = Record<string, unknown>;

const described = (schema: JsonSchema, description?: string): JsonSchema => (description ? { ...schema, description } : schema);
const text = (description?: string): JsonSchema => described({ type: "string" }, description);
const integer = (minimum: number, description?: string): JsonSchema => described({ type: "integer", minimum }, description);
const flag = (description?: string): JsonSchema => described({ type: "boolean" }, description);
const anything = (description?: string): JsonSchema => described({}, description);
const oneOf = (values: string[], description?: string): JsonSchema =>
  described({ anyOf: values.map((value) => ({ type: "string", const: value })) }, description);
const list = (items: JsonSchema, extra: JsonSchema = {}): JsonSchema => ({ type: "array", items, ...extra });
/** An object whose properties are all required except those named optional. */
const object = (properties: Record<string, JsonSchema>, optional: string[] = []): JsonSchema => {
  const required = Object.keys(properties).filter((name) => !optional.includes(name));
  return { type: "object", ...(required.length ? { required } : {}), properties };
};

const sessionId = text("WAICC session UUID, as returned by waicc_status");
const fullReview = flag("Code review only: review the whole change again instead of a follow-up review. Set it ONLY when the human asks for a full review.");
const reviewKind = oneOf(["code", "contract"]);

export const askAdvisorSpec: ToolSpec = {
  name: "waicc_ask_advisor",
  label: "Ask the advisor for a second opinion",
  description:
    "Coordinator only: when you are stuck, ask the human's advisor agent (their advisor role's profile) for a second opinion. It reads the project read-only and answers with a diagnosis, a recommended next step, a fallback and how to confirm. Works with or without a WAICC session; it creates no handoff and changes no contract. Limited per chat by the human's setting, and each call is visible to them. Give a precise question, what you already tried and the exact errors or output.",
  promptSnippet: "Ask the human's advisor agent for a read-only second opinion when you are stuck",
  promptGuidelines: [
    "The human wants you to rely on the advisor: use waicc_ask_advisor whenever you are stuck or the work is difficult, before guessing, going in circles, giving up or asking the human. For example: WAICC refuses your calls twice in a row, a code review comes back with findings a second time, a check still fails after a real fix attempt, you cannot find a defect's cause after investigating, you doubt a reviewer's finding, or you are choosing between risky designs you cannot settle from the source. Not for routine questions you can answer by reading the code, and not to hand off work.",
    "Treat the advisor's answer as a second opinion, not an instruction: verify it against the source before acting, and it never changes scope, decisions or authorization.",
  ],
  parameters: object({
    question: text("What you are stuck on, as one precise question"),
    tried: text("What you already tried and what happened each time"),
    evidence: text("Exact errors, failing test output or observations"),
    paths: list({ type: "string" }, { maxItems: 20, description: "Files the advisor should start from" }),
  }, ["evidence", "paths"]),
};
export interface AskAdvisorParams { question: string; tried: string; evidence?: string; paths?: string[] }

export const checkpointSpec: ToolSpec = {
  name: "waicc_checkpoint",
  label: "Recover compact WAICC context",
  description: "Read-only compact recovery: current canonical owner checkpoint, or the recipient's frozen request checkpoint. Follow exact-contract/evidence pointers; no history deletion, status changes or permission grants.",
  parameters: object({ sessionId }, ["sessionId"]),
};

export const contextSpec: ToolSpec = {
  name: "waicc_context",
  label: "Save WAICC coordinator context",
  description: "Coordinator: save important user context, constraints, source references and established decisions/rationale before handoff. All roles receive a frozen copy. This does not amend requirements or adopt advice. Pending handoffs must first be finished/cancelled.",
  parameters: object({ sessionId, summary: text() }),
};
export interface ContextParams { sessionId: string; summary: string }

export const statusSpec: ToolSpec = {
  name: "waicc_status",
  label: "WAICC status",
  description: "Read full original requirements, contract and reply. Prefer waicc_checkpoint for compact recovery, then expand exact records as needed.",
  parameters: object({ sessionId }, ["sessionId"]),
};
export interface SessionParams { sessionId?: string }

export const startPlanningSpec: ToolSpec = {
  name: "waicc_start_planning",
  label: "Start automatic WAICC planning",
  description: "Coordinator only; auto-planning defaults on: capture the current human work request exactly in a planning-only session when tracked steps, dependencies or completion checks would keep work on track, even for small tasks. Not for trivial one-step edits, questions or skip-planning requests. Requires a live requestId from auto-planning guidance. Never launches agents, changes scope, accepts plans or authorizes coding. Existing selected sessions are returned unchanged, never replaced.",
  parameters: object({
    requestId: text(),
    reason: text("Concrete reason tracked steps/source-backed planning would help keep this work on track; complexity is not required"),
  }),
};
export interface StartPlanningParams { requestId: string; reason: string }

export const prepareSpec: ToolSpec = {
  name: "waicc_prepare",
  label: "Prepare WAICC handoff",
  description:
    "Save a versioned contract and planning/review handoff. Code review (default for review) requires completion evidence for ALL tasks/checks/prior findings; reviewKind contract is specification-only. Never edits application source.",
  parameters: object({
    sessionId,
    expectedVersion: integer(0),
    mode: oneOf(["planning", "review"]),
    focus: text(),
    contract: anything(),
    reviewKind,
    fullReview,
    completion: anything("Whole-work report: {summary,tasks:[{taskId,evidence}],checks:[{description,outcome:passed|not_run,evidence}],findings:[{requestId,findingId,disposition:resolved|disputed,evidence}]}. ALL tasks and prior actionable code findings exactly once; with none (first review), findings may be [] or left out."),
  }, ["reviewKind", "fullReview", "completion"]),
};
export interface PrepareParams {
  sessionId: string; expectedVersion: number; mode: "planning" | "review"; focus: string; contract: unknown;
  reviewKind?: "code" | "contract"; fullReview?: boolean; completion?: unknown;
}

export const assessSpec: ToolSpec = {
  name: "waicc_assess",
  label: "Assess WAICC reply",
  description:
    "Owner: validate/adopt planning with planned -> PLAN_READY; then implement ALL work if authorized. Code-review defects: needs_changes/blocked BEFORE editing, fix ALL issues, then ONE fresh whole-change review; not followup/per-task handoffs. Review ready assesses its pinned kind (code vs contract), never automatic closure or delivery certification. Advisor uses noted. Ready planning is the legacy external implementation handoff.",
  parameters: object({
    sessionId,
    requestId: text(),
    decision: oneOf(["ready", "planned", "noted", "followup", "needs_changes", "blocked"]),
    rationale: text(),
    contract: anything(),
    dispositions: list(object({
      findingId: text(),
      disposition: oneOf(["resolved", "disputed", "accepted"], "resolved: fixed (say where); disputed: not a real problem (the proof); accepted: a real medium/low finding knowingly not fixed now (the reason). Code-review findings cannot be accepted."),
      evidence: text(),
    })),
  }, ["contract"]),
};
export interface AssessParams {
  sessionId: string; requestId: string; decision: "ready" | "planned" | "noted" | "followup" | "needs_changes" | "blocked";
  rationale: string; contract?: unknown;
  dispositions: { findingId: string; disposition: "resolved" | "disputed" | "accepted"; evidence: string }[];
}

export const learnPatternSpec: ToolSpec = {
  name: "waicc_learn_pattern",
  label: "Propose a lesson from findings that recur across sessions",
  description:
    "Coordinator only: when review findings in two or more sessions of this project are the same kind of problem, propose one lesson for future plans. Cite the findings (sessionId, requestId, findingId) from waicc_assess's recurringFindings. WAICC checks each is an assessed, undisputed review finding and that no other lesson uses it. When an existing lesson already covers the pattern, pass its lessonId and only the new findings: that adds support instead of a second lesson. A lesson stays a candidate until the human confirms it with /waicc-memory confirm, or until findings from 3 sessions back it if the human turned on their corroboration rule; once confirmed it reaches every planning handoff.",
  parameters: object({
    lesson: text("Advice for future plans: what to plan or check up front, at most 600 characters (not needed with lessonId)"),
    findings: list(object({ sessionId: text(), requestId: text(), findingId: text() }), { minItems: 1, maxItems: 10 }),
    lessonId: text("An existing lesson that already covers this pattern: the findings are added to it as more support"),
  }, ["lesson", "lessonId"]),
};
export interface LearnPatternParams { lesson?: string; findings: { sessionId: string; requestId: string; findingId: string }[]; lessonId?: string }

export const applyPolicySpec: ToolSpec = {
  name: "waicc_apply_policy",
  label: "Answer a decision by the human's standing policy",
  description:
    "Coordinator only: record the answer to an OPEN human-owned decision that one of the human's standing policies (listed in your instructions) clearly and fully answers. Cite the policy by number; the answer must follow the policy exactly; explain why it applies. Never for external or agent-owned decisions, and never stretched beyond what the policy says: if it only partly fits, ask the human. The answer is announced to the human.",
  parameters: object({
    sessionId,
    decisionId: text(),
    policy: integer(1, "Policy number, as listed"),
    answer: text(),
    rationale: text("Why this policy answers this decision"),
  }),
};
export interface ApplyPolicyParams { sessionId: string; decisionId: string; policy: number; answer: string; rationale: string }

export const requestSpec: ToolSpec = {
  name: "waicc_request",
  label: "WAICC follow-up",
  description:
    "Issue a request without revising scope. Review defaults to code with completion evidence for ALL work/prior findings; no task/batch reviews. Contract-only review is explicit. Implementation/testing require the human's saved delegation choice and accepted current plan. Advisor requirementIds default [] (question only).",
  parameters: object({
    sessionId,
    mode: oneOf(["planning", "review", "advisor", "implementation", "testing"]),
    focus: text(),
    taskId: text(),
    requirementIds: list({ type: "string" }),
    reviewKind,
    fullReview,
    completion: anything("{summary,tasks:[{taskId,evidence}],checks:[{description,outcome:passed|not_run,evidence}],findings:[{requestId,findingId,disposition:resolved|disputed,evidence}]}; every task and previous actionable code-review finding exactly once."),
  }, ["taskId", "requirementIds", "reviewKind", "fullReview", "completion"]),
};
export interface RequestParams {
  sessionId: string; mode: "planning" | "review" | "advisor" | "implementation" | "testing"; focus: string;
  taskId?: string; requirementIds?: string[]; reviewKind?: "code" | "contract"; fullReview?: boolean; completion?: unknown;
}

export const memorySpec: ToolSpec = {
  name: "waicc_memory",
  label: "WAICC project memory",
  description:
    "Recall confirmed project knowledge or propose a source-linked candidate. Candidates are recalled only once confirmed: by the human, or by WAICC's corroboration rule if the human turned it on. For a fact, quote the exact source lines it rests on: an entry without a quote is never confirmed automatically, and one whose quote is still in the file stays current when the rest of the file changes. Proposing the same claim about the same file in a later session supports the earlier entry. To remember a decision the human answered with /waicc-decide, pass kind decision and its decisionId (no claim or source): WAICC records the question and the human's exact answer.",
  parameters: object({
    action: oneOf(["recall", "propose"]),
    query: text(),
    claim: text(),
    source: text(),
    quote: text("The exact lines of the source file the claim rests on, copied from the file"),
    decisionId: text("With kind decision: a decision in the bound session that the human answered with /waicc-decide"),
    kind: oneOf(["fact", "decision", "lesson"]),
  }, ["query", "claim", "source", "quote", "decisionId", "kind"]),
};
export interface MemoryParams {
  action: "recall" | "propose"; query?: string; claim?: string; source?: string; quote?: string; decisionId?: string;
  kind?: "fact" | "decision" | "lesson";
}

export const reportBugsSpec: ToolSpec = {
  name: "waicc_report_bugs",
  label: "Report a bug hunt's candidates",
  description: `Coordinator only, after /waicc-bug-hunt: report the candidate bugs you found in that hunt's scope, at most ${huntLimit}, most severe first. Each needs the file, line, the exact trigger, what goes wrong and a severity. Refused if the source changed since the hunt started. The human's advisor then checks every candidate, and the triaged list is returned for the human to pick from.`,
  parameters: object({
    huntId: text("The hunt ID from the /waicc-bug-hunt instruction"),
    bugs: list(object({
      file: text("Project-relative path"),
      line: integer(1),
      trigger: text("The exact input or state that triggers it"),
      wrong: text("What goes wrong, against what should happen"),
      severity: oneOf(["high", "medium", "low"]),
    }), { maxItems: huntLimit }),
  }),
};
export interface ReportBugsParams {
  huntId: string;
  bugs: { file: string; line: number; trigger: string; wrong: string; severity: "high" | "medium" | "low" }[];
}

/** Every main-agent tool any host offers, in the order Pi registers them. */
export const coordinatorToolSpecs: ToolSpec[] = [
  askAdvisorSpec, checkpointSpec, contextSpec, statusSpec, startPlanningSpec, prepareSpec, assessSpec,
  learnPatternSpec, applyPolicySpec, requestSpec, memorySpec, reportBugsSpec,
];
