/** Why an agent could not work at all: a fallback agent may take the same handoff. */
export interface AgentLimit {
  kind: "usage" | "rate" | "signin" | "missing";
  /** The line that said so, shortened. */
  text: string;
}

const patterns: [AgentLimit["kind"], RegExp][] = [
  ["signin", /not (logged|signed) in|please run \/login|log ?in required|invalid api key|authentication_error|no api key|\b401\b|unauthori[sz]ed/i],
  ["usage", /usage limit|hit your (usage )?limit|(5-hour|weekly|daily|session|monthly) limit|limit (reached|exceeded)|quota|credit balance is too low|out of credits|resource_exhausted/i],
  ["rate", /rate[ _-]?limit|too many requests|\b429\b|overloaded/i],
];
const missing = /ENOENT|not found on PATH|not recognized as an internal or external command|command not found|cannot find the (file|path)/i;

/** What an agent's own error lines say: failed results and error events, never the files it read or its own words. */
function errorTexts(stdout: string): string[] {
  const texts: string[] = [];
  for (const line of stdout.split(/\r?\n/).filter((l) => l.trim()).slice(-40)) {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      texts.push(line); // A plain-text line is the agent's own output, often its error.
      continue;
    }
    if (!j || typeof j !== "object") continue;
    // Claude: a failed result. Codex: error and turn.failed events. Pi: an assistant message that ended in an error. Others: an error field.
    if (j.type === "result" && j.is_error) texts.push(String(j.result ?? j.subtype ?? ""));
    if (typeof j.type === "string" && /error|failed/.test(j.type)) texts.push(String(j.message ?? j.error?.message ?? j.error ?? ""));
    if (j.message?.stopReason === "error") texts.push(String(j.message.errorMessage ?? ""));
    if (typeof j.error === "string") texts.push(j.error);
    else if (typeof j.error?.message === "string") texts.push(j.error.message);
    if (typeof j.errorMessage === "string") texts.push(j.errorMessage);
  }
  return texts;
}

/**
 * Whether a run that submitted no reply failed because the agent hit a usage or rate limit, is
 * not signed in, or is not installed. Only for runs that were not stopped or timed out.
 */
export function agentLimit(result: { stdout: string; stderr: string; killed: boolean }): AgentLimit | null {
  if (result.killed) return null;
  const lines = [...result.stderr.slice(-4000).split(/\r?\n/), ...errorTexts(result.stdout)].map((l) => l.trim()).filter(Boolean);
  const clip = (line: string) => (line.length > 200 ? `${line.slice(0, 199)}…` : line);
  if (!result.stdout.trim()) {
    const line = lines.find((l) => missing.test(l));
    if (line) return { kind: "missing", text: clip(line) };
  }
  for (const [kind, pattern] of patterns) {
    const line = lines.find((l) => pattern.test(l));
    if (line) return { kind, text: clip(line) };
  }
  return null;
}

export const limitText = (limit: AgentLimit): string =>
  ({ usage: "hit its usage limit", rate: "was rate-limited", signin: "is not signed in", missing: "is not installed or could not start" })[limit.kind];
