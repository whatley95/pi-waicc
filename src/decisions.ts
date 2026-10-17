import type { Contract } from "./types.ts";

/** Decision gates propagate through dependencies; this does not schedule execution. */
export function decisionGates(contract: Contract) {
  const pending = (contract.decisions ?? []).filter(
    (d) => d.status !== "resolved",
  );
  const blocked = new Set(pending.flatMap((d) => d.affectedTaskIds));
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of contract.tasks) {
      if (
        !blocked.has(task.id) &&
        task.dependsOn.some((id) => blocked.has(id))
      ) {
        blocked.add(task.id);
        changed = true;
      }
    }
  }
  return {
    pendingDecisions: pending,
    decisionBlockedTaskIds: contract.tasks
      .filter((t) => blocked.has(t.id))
      .map((t) => t.id),
    decisionUnblockedTaskIds: contract.tasks
      .filter((t) => !blocked.has(t.id))
      .map((t) => t.id),
    note: "Decision-unblocked does not mean implemented, tested, dependency-complete or authorized to execute.",
  };
}
