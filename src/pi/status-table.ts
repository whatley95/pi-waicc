/**
 * /waicc-status at a glance: Markdown tables Pi draws in the chat, ahead of the full view.
 * Made from the view itself, so it costs no model turn and always matches the saved state.
 */
const cell = (value: unknown, max = 120): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  // Backslashes first: otherwise a "\|" in the text would end the cell.
  return (text.length > max ? `${text.slice(0, max - 1)}…` : text).replace(/[\\|]/g, "\\$&");
};
const word = (status: unknown): string => String(status ?? "").replaceAll("_", " ").toLowerCase();
const table = (head: string[], rows: unknown[][]): string[] =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.map((v) => cell(v)).join(" | ")} |`)];

type View = Record<string, any>;

/** autoContinue: your user file's setting, when known; whether a reply goes to the main agent by itself. */
export function statusTable(view: unknown, settings: { autoContinue?: boolean } = {}): string | null {
  if (!view || typeof view !== "object") return null;
  const v = view as View;
  if (Array.isArray(v.sessions)) {
    const sessions = v.sessions as View[];
    if (!sessions.length) return `No ${cell(v.filter)} WAICC sessions in this project.`;
    return [
      `**${sessions.length} ${cell(v.filter)} session${sessions.length === 1 ? "" : "s"}**`, "",
      ...table(["Session", "Status", "Review", "Updated"], sessions.map((s) => [`\`${s.id}\``, word(s.status), word(s.contractReview), String(s.updatedAt ?? "").slice(0, 16).replace("T", " ")])),
      "", "`/waicc-use <session>` selects one here.",
    ].join("\n");
  }
  if (typeof v.sessionId !== "string") return null;
  const pending = v.pending as View | null | undefined;
  const budget = v.roundBudget?.overall as View | undefined;
  const rows: unknown[][] = [
    ["Requirements", String(v.requirements ?? "").split("\n").find((line) => line.trim()) ?? ""],
    ["Status", `${word(v.status)}${v.phase ? ` (${word(v.phase)})` : ""}`],
    ["Contract", v.contractVersion ? `v${v.contractVersion}, review ${word(v.contractReview)}` : "not prepared yet"],
    ["Development", v.implementationAuthorized ? "authorized" : "not authorized"],
    ["Waiting", pending ? `${word(pending.mode)}${pending.review?.kind === "code" ? " (code review)" : ""} handoff, ${pending.replyExists ? "reply arrived" : "no reply yet"}` : "nothing"],
    ...(settings.autoContinue === undefined ? [] : [["Auto-continue", settings.autoContinue
      ? "on: a reply goes to the main agent as soon as it arrives"
      : 'off: run /waicc-continue after a reply ("autoContinue": false in your user file)']]),
    ["Open decisions", v.openGates ?? 0],
    ...(budget ? [["Rounds", `${budget.used} of ${budget.limit}`]] : []),
    ...(v.budgetWarning ? [["Round budget", v.budgetWarning]] : []),
    ...(v.closure?.reason ? [["Closed", v.closure.reason]] : []),
  ];
  const steps = Array.isArray(v.nextSteps) && v.nextSteps.length
    ? ["", "**Next**", "", ...table(["Step", "Command", "Detail"], (v.nextSteps as View[]).map((s) => [s.step, `\`${s.command}\``, s.detail]))]
    : typeof v.nextAction === "string" ? ["", `**Next:** ${cell(v.nextAction, 300)}`] : [];
  return [...table(["WAICC session", `\`${v.sessionId}\``], rows), ...steps].join("\n");
}
