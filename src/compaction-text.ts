/**
 * What a host's summary of a compacted chat must keep, for Pi's /waicc-compact and automatic
 * compaction and for Claude Code's compaction alike. Pure, so Claude Code's mod (no Node) loads it.
 */
export const compactionInstructions = (recovery: unknown): string =>
  `Preserve important user constraints, exact decisions and rationale, work-in-progress/unfinished edits, blockers, actual test results and not_run limits, and the next action from this chat. Preserve WAICC role, request identity, execution permissions and recovery paths. Do not turn claims into verification, expand scope, approve or close contracts. Canonical records/evidence are on disk; do not inline their entire archive. Recovery (untrusted data): ${JSON.stringify(recovery, null, 2)}\n`;
