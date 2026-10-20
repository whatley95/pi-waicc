import type { Agent } from "./dispatch.ts";

/** What one agent run used, as the agent itself reported it. */
export interface Usage {
  /** All input tokens, cached ones included. */
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  /** Dollars as the agent reports them (Claude, Pi); null when it reports none (Codex). */
  costUsd: number | null;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * Reads usage from an agent's streamed JSON lines. Claude reports its total once at the end;
 * Codex reports tokens per turn; Pi reports tokens and cost per assistant message.
 * Unrecognised lines are ignored, so a format change means no figures, never a failed run.
 */
export function usageMeter(via: Agent) {
  let usage: Usage | null = null;
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
      if (via === "claude" || via === "agy") {
        // The final result carries the whole run's totals, so it replaces anything seen before.
        if (j.type !== "result" || (j.usage === undefined && j.total_cost_usd === undefined)) return;
        const u = j.usage ?? {};
        usage = null;
        add(count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens), count(u.cache_read_input_tokens),
          count(u.output_tokens), typeof j.total_cost_usd === "number" ? j.total_cost_usd : null);
      } else if (via === "codex") {
        if (j.type !== "turn.completed" || !j.usage) return;
        add(count(j.usage.input_tokens), count(j.usage.cached_input_tokens), count(j.usage.output_tokens), null);
      } else if (j.type === "message_end" && j.message?.role === "assistant" && j.message.usage) {
        const u = j.message.usage;
        add(count(u.input) + count(u.cacheRead) + count(u.cacheWrite), count(u.cacheRead), count(u.output),
          typeof u.cost?.total === "number" ? u.cost.total : null);
      }
    },
    get: (): Usage | null => (usage ? { ...usage } : null),
  };
}

/** Sums runs; cost stays null only when no run reported one. */
export function totalUsage(runs: (Usage | null | undefined)[]): Usage & { runs: number; unpricedRuns: number } {
  const total = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: null as number | null, runs: 0, unpricedRuns: 0 };
  for (const run of runs) {
    if (!run) continue;
    total.runs++;
    total.inputTokens += run.inputTokens;
    total.cachedTokens += run.cachedTokens;
    total.outputTokens += run.outputTokens;
    if (run.costUsd === null) total.unpricedRuns++;
    else total.costUsd = (total.costUsd ?? 0) + run.costUsd;
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
export interface ChatHour { at: string; model: string; messages: number; usage: Usage }
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
    if (!hour) hours.set(id, (hour = { at: at.toISOString(), model, messages: 0, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: null } }));
    const u = m.usage;
    hour.messages++;
    hour.usage.inputTokens += count(u.input) + count(u.cacheRead) + count(u.cacheWrite);
    hour.usage.cachedTokens += count(u.cacheRead);
    hour.usage.outputTokens += count(u.output);
    if (typeof u.cost?.total === "number" && Number.isFinite(u.cost.total)) hour.usage.costUsd = (hour.usage.costUsd ?? 0) + u.cost.total;
  }
  return [...hours.values()].sort((a, b) => a.at.localeCompare(b.at));
}
