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

export function decisionBrief(contract: Contract): string {
  const gates = decisionGates(contract);
  return `# Decision brief\n\n${gates.pendingDecisions.length} open/deferred gates; ${gates.decisionBlockedTaskIds.length} tasks blocked (including dependencies).\nUnblocked task IDs: ${gates.decisionUnblockedTaskIds.join(", ") || "none"}. Unblocked is not completion or permission.\n\n${(contract.decisions ?? []).map((d) => `## ${d.id}: ${d.question}\n\nOwner: ${d.owner}; status: ${d.status}. Affected tasks: ${d.affectedTaskIds.join(", ")}.\nRecommendation: ${d.recommendation}\nEvidence:\n${d.evidence.map((item) => `- ${item}`).join("\n")}\n${d.status === "resolved" ? `Recorded answer: ${d.answer}` : `Human answer command: /waicc-decide ${d.id} <answer>`}\n`).join("\n") || "No decisions recorded."}\n\nAnswers record existing choices only. Requirement/scope changes need an amendment. Do not ask the human to investigate repository-answerable facts.\n`;
}
