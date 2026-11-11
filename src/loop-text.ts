/** What the review loop and /waicc-develop say, for Pi and for Claude Code's mod (which has no Node). */

/** What a request asks: a PathRequest (src/types.ts), or the same read from a status view. */
export type AskedPaths = { additions: { taskId: string; paths: string[] }[]; reason: string; findingIds: string[] };

/** What a path request asks, in one line for the human. */
export const pathRequestText = (request: AskedPaths): string =>
  `${request.additions.map((a) => `${a.taskId}: ${a.paths.join(", ")}`).join("; ")}. Why: ${request.reason}${request.findingIds.length ? ` (findings ${request.findingIds.join(", ")})` : ""}`;

/** For a review loop's turn that ended with the fixes unfinished and nothing asked of the human. */
export const nudgeText = (cycle: number, max: number): string =>
  `The review loop (cycle ${cycle} of ${max}) is waiting for your fresh code review, but your last turn ended without requesting it. If the fixes are done, request ONE fresh review now with waicc_request (mode review) and the completion report. If they are not, finish them and run the checks first, then request it. If a fix needs files outside the allowed paths, ask with waicc_request_paths. Only if something truly needs the human (a decision, a blocker, a finding you dispute) say what in two or three lines and end your turn without requesting.`;

/** Why a review loop paused for the human's /waicc-develop. */
export const pathsPauseText = (name: string, cycle: number, max: number, request: AskedPaths): string =>
  `${name} paused after cycle ${cycle}/${max}: the main agent asks to change more files. ${pathRequestText(request)}. /waicc-develop approves them and lets it finish the fixes; then /waicc-dispatch --loop sends the fresh review.`;
