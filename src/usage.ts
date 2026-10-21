import type { Agent } from "./dispatch.ts";

/** What one agent run used, as the agent itself reported it. */
export interface Usage {
  /** All input tokens, cached ones included. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Dollars as the agent reports them (Claude, Pi); null when it reports none (Codex) or $0 for real tokens (no price set). */
  costUsd: number | null;
  /** "api-equivalent" when the agent priced a subscription run at API list prices (Claude signed in with claude.ai). */
  costBasis?: "api-equivalent";
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
/** A reported price, or null when there is none, or it is $0 for tokens that were used: a model with no price set, not a free run. */
export const reportedCost = (cost: unknown, tokens: number): number | null =>
  typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && !(cost === 0 && tokens > 0) ? cost : null;

/**
 * Reads usage from an agent's streamed JSON lines. Claude reports its total once at the end;
 * Codex reports tokens per turn; Pi reports tokens and cost per assistant message.
 * Unrecognised lines are ignored, so a format change means no figures, never a failed run.
 */
export function usageMeter(via: Agent) {
  let usage: Usage | null = null;
  // Claude says how it is signed in when it starts: no API key means a claude.ai subscription,
  // whose reported cost is what the run would cost at API prices, not money spent.
  let subscription = false;
  const add = (input: number, cached: number, output: number, cost: number | null) => {
    usage ??= { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: null };
    usage.inputTokens += input;
    usage.cachedTokens += cached;
    usage.outputTokens += output;
    if (cost !== null) usage.costUsd = (usage.costUsd ?? 0) + cost;
  };
  return {
    read(line: string): void {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (!j || typeof j !== "object") return;
      if (via === "agy") {
        // Antigravity reports tokens per response step and the run's total on its result; no price.
        // Its fields are separate (total_tokens is input + output only): cache reads are input
        // on top of input_tokens, and thinking tokens are output, as models bill them.
        const step = j.event === "step_update" && j.step_update?.step_type === "agent_response" && j.step_update.state === "DONE" ? j.step_update.usage : null;
        const total = j.event === "result" ? j.result?.usage : null;
        const u = total ?? step;
        if (!u) return;
        if (total) usage = null;
        const cached = count(u.cache_read_tokens);
        add(count(u.input_tokens) + cached, cached, count(u.output_tokens) + count(u.thinking_tokens), null);
        return;
      }
      if (via === "claude") {
        if (j.type === "system" && j.subtype === "init" && typeof j.apiKeySource === "string") subscription = j.apiKeySource === "none";
        // The final result carries the whole run's totals, so it replaces anything seen before.
        if (j.type !== "result" || (j.usage === undefined && j.total_cost_usd === undefined)) return;
        const u = j.usage ?? {};
        usage = null;
        const input = count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens);
        add(input, count(u.cache_read_input_tokens), count(u.output_tokens), reportedCost(j.total_cost_usd, input + count(u.output_tokens)));
        if (subscription && usage) (usage as Usage).costBasis = "api-equivalent";
      } else if (via === "codex") {
        if (j.type !== "turn.completed" || !j.usage) return;
        add(count(j.usage.input_tokens), count(j.usage.cached_input_tokens), count(j.usage.output_tokens), null);
      } else if (j.type === "message_end" && j.message?.role === "assistant" && j.message.usage) {
        const u = j.message.usage;
        const input = count(u.input) + count(u.cacheRead) + count(u.cacheWrite);
        add(input, count(u.cacheRead), count(u.output), reportedCost(u.cost?.total, input + count(u.output)));
      }
    },
    get: (): Usage | null => (usage ? { ...usage } : null),
  };
}

/** Sums runs; cost stays null only when no run reported one. */
export function totalUsage(runs: (Usage | null | undefined)[]): Usage & { runs: number; unpricedRuns: number; apiEquivalentUsd: number } {
  const total = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: null as number | null, runs: 0, unpricedRuns: 0, apiEquivalentUsd: 0 };
  for (const run of runs) {
    if (!run) continue;
    total.runs++;
    total.inputTokens += run.inputTokens;
    total.cachedTokens += run.cachedTokens;
    total.outputTokens += run.outputTokens;
    if (run.costUsd === null) total.unpricedRuns++;
    else total.costUsd = (total.costUsd ?? 0) + run.costUsd;
    if (run.costBasis === "api-equivalent" && run.costUsd !== null) total.apiEquivalentUsd += run.costUsd;
  }
  return total;
}

const tokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n));
/** "$0.75 · 433k tokens", or tokens alone when the agent reports no price. */
export function usageText(usage: Usage | null | undefined): string | null {
  if (!usage) return null;
  const all = usage.inputTokens + usage.outputTokens;
  return `${usage.costUsd !== null ? `$${usage.costUsd.toFixed(2)} · ` : ""}${tokens(all)} tokens`;
}

/** The main agent's use in one model for one hour of a Pi chat. */
export interface ChatHour {
  at: string; model: string; messages: number; usage: Usage;
  /** Seconds the model spent producing its replies (request to finished message), and the output tokens of those timed replies. */
  seconds?: number; timedOutput?: number;
  /** Replies that came with no price, or $0 for real tokens: a model with no price set. */
  unpriced?: number;
}
/**
 * The main agent's use, from a Pi chat's saved entries: every assistant message on every branch,
 * since each one was paid for. Grouped by model and hour so a long chat stays small.
 */
export function chatUsage(entries: readonly unknown[]): ChatHour[] {
  const hours = new Map<string, ChatHour>();
  for (const entry of entries as any[]) {
    const m = entry?.type === "message" ? entry.message : null;
    if (m?.role !== "assistant" || !m.usage || typeof m.model !== "string") continue;
    const at = new Date(typeof entry.timestamp === "string" ? entry.timestamp : m.timestamp);
    if (Number.isNaN(at.getTime())) continue;
    at.setUTCMinutes(0, 0, 0);
    const model = typeof m.provider === "string" && m.provider ? `${m.provider}/${m.model}` : m.model;
    const id = `${at.toISOString()}\0${model}`;
    let hour = hours.get(id);
    if (!hour) hours.set(id, (hour = { at: at.toISOString(), model, messages: 0, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: null }, seconds: 0, timedOutput: 0, unpriced: 0 }));
    const u = m.usage;
    const input = count(u.input) + count(u.cacheRead) + count(u.cacheWrite), output = count(u.output);
    hour.messages++;
    hour.usage.inputTokens += input;
    hour.usage.cachedTokens += count(u.cacheRead);
    hour.usage.outputTokens += output;
    const cost = reportedCost(u.cost?.total, input + output);
    if (cost === null) hour.unpriced!++;
    else hour.usage.costUsd = (hour.usage.costUsd ?? 0) + cost;
    // The message is stamped when the request starts and saved when the reply ends.
    const started = typeof m.timestamp === "number" ? m.timestamp : Date.parse(String(m.timestamp ?? ""));
    const seconds = (Date.parse(String(entry.timestamp ?? "")) - started) / 1000;
    if (output > 0 && seconds > 0 && seconds < 1800) {
      hour.seconds! += seconds;
      hour.timedOutput! += output;
    }
  }
  return [...hours.values()].sort((a, b) => a.at.localeCompare(b.at));
}
