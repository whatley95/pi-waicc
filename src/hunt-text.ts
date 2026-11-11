/**
 * A bug hunt's limits and the main agent's instructions for it, as Pi (src/pi/hunt.ts) and Claude
 * Code's mod give them. Pure, so the mod (no Node) can load it.
 */
/** Candidates per report: more makes triage slow and the pick hard to read. */
export const huntLimit = 15;
/** Above this many picked bugs, one session is suggested to be split. */
export const pickSplitAt = 10;

/** The read-only scan the main agent does for hunt `id` over `scope`. */
export const huntScanPrompt = (id: string, scope: string): string =>
  `Bug hunt ${id} over (data): ${JSON.stringify(scope)}\n\nRead the code in that scope in detail, and what it calls where that matters, to find real defects: wrong results, crashes, unhandled errors or edge cases, races, resource leaks, security holes, and behaviour that contradicts its own docs or tests. Skip style, naming and refactoring wishes.\n\nThis is a read-only scan. Do not edit, create, delete or format any file, and run nothing that changes files (no fixes, formatters, code generators, dependency installs or tests that write snapshots). WAICC refuses the report if the source changed during the hunt.\n\nFor each candidate, name the file and line, the exact input or state that triggers it, what goes wrong, and a severity (high, medium or low). Report at most ${huntLimit}, most severe first; leave out anything you cannot tie to a concrete trigger. Then call waicc_report_bugs once with huntId ${id}; an empty list means you found none. Your advisor checks the list after that, and the human picks what to fix: do not start fixing or planning.`;

/** What the main agent does once the human picked bugs `ids`: plan their fixes in the new session. */
export const huntPickPrompt = (ids: string[]): string =>
  `The human picked ${ids.join(", ")} from a bug hunt; they are this session's requirements. Use waicc_prepare for a planning contract with one requirement per bug, each naming its failing test or repro as the completion check. Verify each bug against the source while planning; if one turns out not to be a bug, say so in the contract rather than inventing a fix. Do not implement while planning.`;
