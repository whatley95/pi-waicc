import type { Contract, ContractDecision } from "./types.ts";

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

/** Subjects that always stay with the human, whatever a risk rating says. */
const sensitive = /\b(access|credentials?|passwords?|secrets?|tokens?|api keys?|staging|production|prod|deploy\w*|release|payments?|billing|money|costs?|pric\w*|delet\w*|drop|migrat\w*|personal data|pii|privacy|legal|licen[cs]\w*|security|permissions?|authori[sz]\w*)\b/i;

/** Whether the human's autoDecide setting may accept this decision's recommendation. */
export function autoDecidable(decision: ContractDecision): { ok: boolean; reason: string } {
  if (decision.status === "resolved") return { ok: false, reason: "already resolved" };
  if (decision.owner !== "human") return { ok: false, reason: decision.owner === "external" ? "external decisions always need a person" : "agents resolve agent-owned decisions themselves" };
  if (decision.risk !== "low") return { ok: false, reason: decision.risk ? `rated ${decision.risk} risk` : "no risk rating" };
  if (decision.reversible !== true) return { ok: false, reason: "not marked reversible" };
  const subject = sensitive.exec(`${decision.question} ${decision.recommendation}`);
  if (subject) return { ok: false, reason: `mentions "${subject[0]}", which always stays with you` };
  return { ok: true, reason: "low risk, reversible, human-owned and nothing sensitive" };
}
