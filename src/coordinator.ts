import { json, loadSession, sessionRelative } from "./files.ts";
import { consultSettings, decisionSettings } from "./profiles.ts";
import type { DispatchOptions } from "./dispatch.ts";
import { autoDecidable } from "./decisions.ts";
import { learnPattern, recurringFindings } from "./learning.ts";
import { propose, proposeDecision } from "./memory.ts";
import { elapsed } from "./progress.ts";
import { projectRoot } from "./source.ts";
import { versionDirectory, type manualHandoff } from "./render.ts";
import { assess, decisionsView, issue, prepare, readContract, requirementsText, resolveDecision, status, type Assessment } from "./workflow.ts";
import { contractSizeNote, contractTidyNote, ensure, tidyIds } from "./validation.ts";
import type { ContractDecision } from "./types.ts";
import type { ApplyPolicyParams, AssessParams, LearnPatternParams, MemoryParams, PrepareParams, RequestParams } from "./tool-specs.ts";

/**
 * What the main agent's WAICC tools do, whatever the host: Pi (src/pi) or another. Each returns
 * the agent's result and, beside it, what the human is told; the host draws those its own way.
 * Checks of the chat itself (trust, recipient or coordinator) stay with the host.
 */
export interface Notice { level: "info" | "warning"; text: string }
export interface Outcome {
  /** What the agent reads, before agentText bounds it. */
  result: unknown;
  /** Short notices for the human, as a host shows a toast. */
  notices: Notice[];
  /** Longer messages for the human, shown in the conversation without starting a turn. */
  messages: string[];
}

/** What the agent is told when tidyIds renamed IDs in its contract. */
export const idsTidied = (renamed: [string, string][]): string =>
  `IDs may use only letters, digits, - and _, so these were renamed everywhere in the contract; use the new IDs from now on: ${renamed.map(([from, to]) => `${JSON.stringify(from)} → ${to}`).join(", ")}`;

/** Name what was sent: an agent sent reviewKind with a planning handoff. */
function reviewOnly(params: { mode: string; reviewKind?: unknown; completion?: unknown; fullReview?: boolean }): void {
  const sent = [params.reviewKind === undefined ? "" : "reviewKind", params.completion === undefined ? "" : "completion"].filter(Boolean);
  ensure(params.mode === "review" || !sent.length,
    `${sent.join(" and ")} ${sent.length > 1 ? "apply" : "applies"} only to mode review; this is a ${params.mode} handoff, so leave ${sent.length > 1 ? "them" : "it"} out`);
  ensure(!params.fullReview || (params.mode === "review" && (params.reviewKind ?? "code") === "code"), "fullReview applies only to a code review");
}
/** A new handoff that leaves 2 rounds or fewer is told to the human at once, not only to the agent. */
const budgetNotices = (view: unknown): Notice[] => {
  const warning = (view as { budgetWarning?: string | null }).budgetWarning;
  return warning ? [{ level: "warning", text: warning }] : [];
};
const review = (params: { mode: string; reviewKind?: "code" | "contract"; completion?: unknown; fullReview?: boolean }) =>
  params.mode === "review" ? { kind: params.reviewKind ?? "code", completion: params.completion, full: params.fullReview } : undefined;

/** waicc_prepare: save the contract version and its planning or review handoff. */
export function prepareHandoff(cwd: string, params: PrepareParams): Outcome {
  reviewOnly(params);
  const tidy = tidyIds(params.contract);
  prepare(cwd, params.sessionId, tidy.value, params.mode, params.focus, params.expectedVersion, review(params));
  const view = stepView(status(cwd, params.sessionId)) as object;
  const saved = readContract(cwd, params.sessionId).contract;
  const contractSize = contractSizeNote(saved);
  const contractTidy = contractTidyNote(saved);
  return {
    result: { ...(tidy.renamed.length ? { idsTidied: idsTidied(tidy.renamed) } : {}), ...(contractSize ? { contractSize } : {}), ...(contractTidy ? { contractTidy } : {}), ...view },
    notices: budgetNotices(view), messages: [],
  };
}

/** waicc_request: a new handoff on the current contract. */
export function requestHandoff(cwd: string, params: RequestParams): Outcome {
  reviewOnly(params);
  issue(cwd, params.sessionId, params.mode, params.focus, params.taskId, params.requirementIds, review(params));
  const view = stepView(status(cwd, params.sessionId));
  return { result: view, notices: budgetNotices(view), messages: [] };
}

/** waicc_assess: the owner's decision on a reply, then what follows from it. */
export function assessReply(cwd: string, params: AssessParams): Outcome {
  // A contract adopted here is tidied as waicc_prepare tidies one.
  const tidy = params.contract === undefined ? null : tidyIds(params.contract);
  const assessed = assess(cwd, params.sessionId, (tidy ? { ...params, contract: tidy.value } : params) as Assessment);
  const kept = assessed.rounds.find((round) => round.id === params.requestId)?.dispositions?.length ?? 0;
  const dispositionsIgnored = params.dispositions.length > kept
    ? `This reply has no findings, so your ${params.dispositions.length} finding disposition(s) (${params.dispositions.map((d) => d.findingId).join(", ")}) were left out. Next time send dispositions: [] for a reply without findings.`
    : null;
  const decided = acceptLowRisk(cwd, params.sessionId);
  let recurring: ReturnType<typeof recurringFindings> = null;
  try {
    recurring = recurringFindings(cwd, params.sessionId, params.requestId);
  } catch { /* learning is a bonus; the assessment stands */ }
  const saved = params.contract === undefined ? null : readContract(cwd, params.sessionId).contract;
  const contractSize = saved && contractSizeNote(saved);
  const contractTidy = saved && contractTidyNote(saved);
  return {
    result: {
      ...(tidy?.renamed.length ? { idsTidied: idsTidied(tidy.renamed) } : {}),
      ...(dispositionsIgnored ? { dispositionsIgnored } : {}), ...(contractSize ? { contractSize } : {}), ...(contractTidy ? { contractTidy } : {}),
      ...(decided.accepted.length ? { autoDecided: decided.accepted } : {}), ...(recurring ? { recurringFindings: recurring } : {}),
      ...(stepView(status(cwd, params.sessionId)) as object),
    },
    notices: decided.notices, messages: decided.messages,
  };
}

/** The human's autoDecide setting: accept qualifying recommendations, and say so. */
export function acceptLowRisk(cwd: string, id: string): { accepted: string[]; notices: Notice[]; messages: string[] } {
  const none = { accepted: [], notices: [], messages: [] };
  let enabled = false;
  try {
    enabled = decisionSettings(cwd).autoDecide === "low-risk";
  } catch {
    return none;
  }
  if (!enabled) return none;
  let decisions: ContractDecision[] = [];
  try {
    decisions = readContract(cwd, id).contract.decisions ?? [];
  } catch {
    return none;
  }
  const accepted: string[] = [];
  for (const decision of decisions.filter((d) => autoDecidable(d).ok)) {
    try {
      resolveDecision(cwd, id, decision.id, decision.recommendation, { kind: "auto-low-risk" });
      accepted.push(`${decision.id}: ${decision.question} → ${decision.recommendation}`);
    } catch {
      break; // For example a pending handoff: the next assessment tries again.
    }
  }
  if (!accepted.length) return none;
  return {
    accepted,
    notices: [{ level: "info", text: `${accepted.length} low-risk decision${accepted.length === 1 ? "" : "s"} accepted automatically.` }],
    messages: [`Accepted automatically under your autoDecide setting (low risk, reversible, nothing sensitive):\n${accepted.map((line) => `• ${line}`).join("\n")}\nReview with /waicc-decisions. Everything else still waits for you.`],
  };
}

/** waicc_apply_policy: answer an open human-owned decision by one of the human's standing policies. */
export function applyPolicy(cwd: string, params: ApplyPolicyParams): Outcome {
  const { policies } = decisionSettings(cwd);
  const policy = policies[params.policy - 1];
  ensure(policy, policies.length ? `There is no policy ${params.policy}; the human has ${policies.length}.` : "The human has no standing policies; ask them to decide.");
  const decision = (readContract(cwd, params.sessionId).contract.decisions ?? []).find((d) => d.id.toLowerCase() === params.decisionId.toLowerCase());
  ensure(decision && decision.status !== "resolved", `No open decision ${JSON.stringify(params.decisionId)}.`);
  ensure(decision.owner === "human", decision.owner === "external"
    ? "External decisions need the person who owns them; a policy cannot answer them."
    : "Agent-owned decisions are resolved by investigation, not by policies.");
  ensure(params.answer.trim() && params.rationale.trim(), "Give the answer and why the policy applies");
  resolveDecision(cwd, params.sessionId, decision.id, params.answer.trim(), { kind: "policy", policy, rationale: params.rationale.trim() });
  return {
    result: { ...decisionsView(cwd, params.sessionId), session: stepView(status(cwd, params.sessionId)) },
    notices: [{ level: "info", text: `${decision.id} answered by your standing policy ${params.policy}.` }],
    messages: [`${decision.id} answered by your policy ${params.policy} ("${policy}"): ${params.answer.trim()}\nWhy: ${params.rationale.trim()}\nReview with /waicc-decisions.`],
  };
}

/** waicc_learn_pattern: a lesson candidate, or more support for one, from findings that recur. */
export function proposeLesson(cwd: string, params: LearnPatternParams): Outcome {
  const entry = learnPattern(cwd, params.lesson, params.findings, params.lessonId);
  return {
    result: {
      proposed: entry,
      nextAction: "Tell the human you proposed this lesson and why. It is a candidate only: they review it with /waicc-memory and confirm it with /waicc-memory confirm. Never confirm it yourself.",
    },
    notices: [{
      level: "info",
      text: params.lessonId
        ? `Lesson strengthened by recurring review findings: ${entry.text.slice(0, 160)} (${entry.source})`
        : `Lesson candidate from recurring review findings: ${entry.text.slice(0, 160)} (/waicc-memory to confirm)`,
    }],
    messages: [],
  };
}

/** waicc_memory propose: a source-linked candidate, or the human's answer to a decision. */
export function proposeMemory(cwd: string, params: MemoryParams, by: { sessionId: string | null; model: string | null }): unknown {
  if (params.decisionId) {
    ensure(by.sessionId, "Bind the session the decision belongs to with /waicc-use first");
    return proposeDecision(cwd, by.sessionId, params.decisionId, by);
  }
  ensure(
    params.claim && params.source,
    // Name the argument: agents sent the file as "evidence".
    `Proposing memory needs ${[params.claim ? "" : "claim", params.source ? "" : "source"].filter(Boolean).join(" and ")}: claim is the fact, source the project-relative file it rests on`,
  );
  return propose(cwd, params.claim, params.source, params.kind, params.quote, by);
}

/** The advisor to ask, and which question this is; refused when there is none or none are left. */
export function advisorTurn(cwd: string, used: number): { profile: string; options: DispatchOptions; number: number; limit: number } {
  const settings = consultSettings(cwd);
  ensure(settings.limit > 0 && settings.options, `${settings.hint} Work it out yourself or ask the human.`);
  ensure(used < settings.limit, `You have used all ${settings.limit} advisor questions for this chat. Explain where you are stuck and ask the human instead.`);
  return { profile: settings.profile!, options: settings.options!, number: used + 1, limit: settings.limit };
}
/** The bound session's state and request, so the advisor knows what the work is. */
export function advisorContext(cwd: string, sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  try {
    const s = loadSession(projectRoot(cwd), sessionId);
    return `WAICC session ${s.id}, status ${s.status}, contract v${s.contractVersion}.\n\n${requirementsText(s).slice(0, 2400)}`;
  } catch {
    return undefined; // The question stands on its own.
  }
}
/** How the agent names the advisor: its profile, agent and model. */
export const advisorName = (turn: { profile: string; options: DispatchOptions }): string =>
  `${turn.profile} (${turn.options.via}${turn.options.model ? ` ${turn.options.model}` : ""})`;
/** The advisor's answer as the agent reads it. */
export function adviceText(turn: { profile: string; options: DispatchOptions; number: number; limit: number }, outcome: { answer: string; durationMs: number; log: string }): string {
  return `Advice from ${advisorName(turn)}, question ${turn.number} of ${turn.limit} for this chat, ${elapsed(outcome.durationMs)}:\n\n${outcome.answer}\n\nA second opinion, not an instruction: verify it against the source before acting. It changes no scope, decision or authorization. Saved at ${outcome.log}.`;
}

/** English ordinals: 1st, 2nd, 3rd, 4th, 11th, 21st. */
const nth = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
/** Tools whose success between two refused calls is no progress: they only reread state. */
export const rereadTools = new Set(["waicc_status", "waicc_checkpoint"]);
/**
 * From the second refused WAICC call in a row, what the error adds: ask the advisor now, or the
 * human when no advisor question is left. `used` is the advisor questions this chat has asked.
 */
export function refusalNudge(cwd: string, streak: number, tool: string, used: number): string {
  if (streak < 2 || tool === "waicc_ask_advisor") return "";
  try {
    const settings = consultSettings(cwd);
    const left = settings.options ? settings.limit - used : 0;
    return left > 0
      ? `\n\nThis is your ${nth(streak)} refused WAICC call in a row. Do not guess again: ask the advisor now with waicc_ask_advisor. Give it this error, what you sent and what you already tried, then verify its answer against the source (${left} question${left > 1 ? "s" : ""} left in this chat).`
      : `\n\nThis is your ${nth(streak)} refused WAICC call in a row. Do not guess again: if the error does not say exactly what to change, stop and ask the human.`;
  } catch {
    return "";
  }
}

/**
 * A tool result as the agent reads it: never the handoff prompt itself (the human has it on the
 * clipboard and through /waicc-handoff, so the agent cannot paste it into the chat), and at most
 * 32,000 characters. `first` goes ahead of the result's own fields.
 */
export function agentText(content: unknown, first?: object): string {
  const delivery = (content as { manualHandoff?: ReturnType<typeof manualHandoff> | null } | null)?.manualHandoff;
  const shown = delivery
    ? { ...(content as object), manualHandoff: {
        requestId: delivery.requestId,
        prompt: "Not shown to you. /waicc-handoff shows and copies it for the human; show nextSteps instead.",
        afterReply: delivery.afterReply, resumeCoordinatorCommand: delivery.resumeCoordinatorCommand, continueCommand: delivery.continueCommand,
      } }
    : content;
  const whole = first ? { ...first, ...(shown as object) } : shown;
  if (!whole || typeof whole !== "object" || Array.isArray(whole)) {
    const serialized = json(whole);
    return serialized.length <= resultLimit ? serialized : `${serialized.slice(0, resultLimit)}\n[Preview bounded; inspect the session files for the full artifact.]`;
  }
  // What to do next comes first: a result cut at its end once lost exactly that.
  const { nextAction, ...rest } = whole as Record<string, unknown>;
  let view: Record<string, unknown> = "nextAction" in whole ? { nextAction, ...rest } : rest;
  let serialized = json(view);
  // Too long: the largest fields give way to where they are, instead of the end being cut off.
  if (serialized.length > resultLimit) {
    let folder: string | undefined;
    try {
      if (typeof view.projectRoot === "string" && typeof view.sessionId === "string") folder = `${view.projectRoot}/${sessionRelative(view.sessionId)}`;
    } catch { /* not a session ID: no folder to name */ }
    const where = folder ?? "the session's files";
    const largest = Object.entries(view).filter(([name]) => !kept.has(name)).map(([name, value]) => [name, JSON.stringify(value ?? null).length] as const)
      .sort((a, b) => b[1] - a[1]);
    for (const [name, size] of largest) {
      if (serialized.length <= resultLimit) break;
      const left = `${size.toLocaleString("en")} characters left out to keep this result whole: in ${where}`;
      const ids = itemIds(view[name]);
      // A list of findings or tasks keeps its IDs: a completion report answers each one by ID.
      view = { ...view, [name]: name === "contract" ? contractSummary(view.contract, folder) : ids ? { left, ids } : `(${left})` };
      serialized = json(view);
    }
  }
  return serialized.length <= resultLimit
    ? serialized
    : `${serialized.slice(0, resultLimit)}\n[Preview bounded; inspect the session files for the full artifact.]`;
}
/** A list of items with IDs as "r3/F2 (high)" lines, or null for anything else. */
function itemIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const items = value as { id?: unknown; requestId?: unknown; severity?: unknown }[];
  if (!items.every((item) => item && typeof item === "object" && typeof item.id === "string")) return null;
  return items.map((item) => `${typeof item.requestId === "string" ? `${item.requestId}/` : ""}${item.id}${typeof item.severity === "string" ? ` (${item.severity})` : ""}`);
}
/** At most this many characters of a tool result. */
const resultLimit = 32_000;
/** Fields a result never gives way: what to do next, and what the human is waiting on. */
const kept = new Set(["nextAction", "sessionId", "projectRoot", "status", "phase", "pending", "nextSteps", "manualHandoff", "budgetWarning",
  "handoffClipboard", "idsTidied", "contractSize", "contractTidy", "dispositionsIgnored", "autoDecided", "decisionGates", "openGates"]);

/**
 * A contract version in a few numbers, with where it is whole: what a step's result needs of it.
 * Given the session's folder, it names the version's file there (for a waicc_status too long to show).
 */
export function contractSummary(contract: unknown, sessionFolder?: string): unknown {
  const v = contract as { version?: number; sessionId?: string; contract?: { title?: string; requirements?: unknown[]; tasks?: { acceptance?: unknown[] }[]; decisions?: { status?: string }[] } } | null;
  if (!v?.contract) return contract;
  const c = v.contract;
  return {
    version: v.version, title: c.title, requirements: c.requirements?.length ?? 0, tasks: c.tasks?.length ?? 0,
    acceptanceCriteria: (c.tasks ?? []).reduce((n, t) => n + (t.acceptance?.length ?? 0), 0),
    openDecisions: (c.decisions ?? []).filter((d) => d.status !== "resolved").length, decisions: (c.decisions ?? []).length,
    characters: JSON.stringify(c).length,
    whole: sessionFolder && typeof v.version === "number" ? `in ${sessionFolder}/${versionDirectory(v.version)}/contract.json` : "waicc_status shows the whole contract",
  };
}
/**
 * The session's status as the result of a step that changed it (prepare, request, assess, context),
 * with what the agent wrote or just read named instead of shown again: the contract as a summary, the
 * request's text and the saved context by size, the last assessment and reply by ID and decision.
 * Every such result carried all of it (one session: 365,000 characters, cut to 32,000 at its end).
 * waicc_status still shows everything. The open code-review findings (codeReviewFindings, which a
 * completion report must answer), decisions, next steps and the handoff stay as they are.
 */
export function stepView(view: unknown): unknown {
  const v = view as { contract?: unknown; requirements?: unknown; coordinatorContext?: { summary?: string } | null;
    lastAssessment?: Record<string, unknown> | null; lastReply?: Record<string, unknown> | null } | null;
  if (!v || typeof v !== "object" || !v.contract) return view;
  const shows = "waicc_status shows";
  const a = v.lastAssessment;
  const findings = Array.isArray(a?.findings) ? (a.findings as { id?: string; severity?: string }[]).map((f) => `${f.id} (${f.severity})`) : [];
  return {
    ...v,
    contract: contractSummary(v.contract),
    ...(typeof v.requirements === "string" ? { requirements: `the request and amendments: ${v.requirements.length.toLocaleString("en")} characters; ${shows} them` } : {}),
    ...(v.coordinatorContext ? { coordinatorContext: `saved (${(v.coordinatorContext.summary ?? "").length.toLocaleString("en")} characters); ${shows} it` } : {}),
    ...(a ? { lastAssessment: { requestId: a.requestId, mode: a.mode, reviewKind: a.reviewKind, decision: a.decision, findings, checkLogs: a.checkLogs, advisor: a.advisor,
      whole: `${shows} its rationale, dispositions, findings and the reply's report` } } : {}),
    ...(v.lastReply ? { lastReply: { requestId: v.lastReply.requestId, mode: v.lastReply.mode, status: v.lastReply.status, artifactPath: v.lastReply.artifactPath } } : {}),
  };
}
