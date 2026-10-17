# Source-first investigation and contract ownership

The contract delegates investigation and technical judgment; it is not a questionnaire
for the human to orchestrate. Inspect code, call sites, tests, docs, history and
accessible reference projects before asking questions. Explain what file/symbol
evidence establishes; a grep match alone is not proof. Record inaccessible inputs
honestly. Do not infer credentials, backend behavior, security or production approval.

The owner captures a requirements/context brief and constraints. An initial planning
draft may use tasks: []; do not speculate a detailed plan merely to dispatch work.
The planner investigates and returns a complete proposedContract: source-backed
paths, dependencies/shared-file sequencing, acceptance and verification plans.
The reviewer independently compares the entire implementation and significant claims
to actual code/tests/docs, not just JSON or another agent's narrative. The advisor investigates before comparing
options and recommending within its selected scope.

For planning, addressed coverage means a source-backed task/acceptance criterion
covers the requirement (possibly with an explicit future gate), not implemented code
or passing tests. Not-run builds/tests alone do not make every planning row unverified.
Do not claim execution when source inspection is the only evidence. Pi recipient
shell permissions remain unchanged; unavailable checks remain not_run.

Resolve agent-owned technical questions. Make low-risk reversible in-scope assumptions
explicit. Escalate only genuine unavailable human/external decisions, consolidating
duplicates into one concise brief with evidence, recommendation and affected tasks.
Carry established answers forward; do not re-send the same question list unchanged.
Put future decisions in contract.decisions, retaining plain questions for issues
that really prevent a coherent specification. Never hide a blocker just to pass.

Decision shape: {id,question,owner,status,affectedTaskIds,evidence,recommendation,answer?}.
owner is agent/human/external, status is open/resolved/deferred. Reference existing
tasks, include investigation evidence/access limits and a recommendation. Resolved
needs an evidence-backed answer; open/deferred must not claim one. Preserve decision
IDs/questions across revisions. Open agent-owned decisions prevent plan acceptance;
future human/external choices gate their affected tasks and dependent tasks. Do not
accidentally chain otherwise unblocked work behind a gated task. Gate lists are not
an execution scheduler or proof of completed dependencies.

The owner spot-checks material claims and explicitly saves supported in-scope
corrections with waicc_assess.contract; saying a change is accepted does not update
the contract on disk. Use planned on complete planning (reply planned or ready) to
reach PLAN_READY without an external implementation handoff. Coverage must be addressed, plain
questions empty, no failed checks, and high/critical findings need dispositions.
If those are missing, investigate rather than fabricate them. Future gates remain
visible; they do not require another identical planning round.

For authorized development, the main agent by default completes ALL planned work itself
in dependency order and runs relevant checks before ONE independent code review.
Do not review per task, finding or batch. Planning-only scope stops at PLAN_READY;
the plan does not create new authority. Real remaining gates block all-done code
review, even if unblocked work can be finished first.
If the human selected implementationOwner delegate, the main agent instead coordinates
ONE complete implementation/fix handoff and independently assesses the returned diff
and evidence. Testing delegation is optional, selected through /waicc-test; it is not
another required handoff. All roles read the same frozen saved-context packet and
confirmed-memory snapshot. Important chat-only context must first be saved by the owner.

Code review uses reviewKind code and a completion report covering every task,
actual checks/not_run limits and every prior actionable review finding by requestId
and findingId. The reviewer verifies the whole implementation, prior fixes,
acceptance criteria and regressions each time, not only the latest delta. On failure,
assess needs_changes BEFORE editing, fix ALL issues, check the whole result, then
issue ONE fresh full review with updated completion evidence. Do not use followup
for code-review defects. Missing verification must not be disguised as a pass.

Changed contracts need fresh review. Explicit reviewKind contract
(`/waicc-review --contract`) and legacy unmarked reviews assess only the specification
and may retain future gates. Their PASS never means code changes passed review.
Legacy planning ready creates an external implementation handoff only when deliberately
requested and all execution decisions are resolved; it is not the main-agent flow.

Follow up only for genuinely new investigable work. If only a human/external answer
remains, give one recommended decision brief and record needs_changes/blocked instead
of repeating unchanged rounds. Do not auto-adopt scope changes, confirm memory,
spawn external processes, deploy or close the discussion without its required human action.
