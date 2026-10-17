# Same-session development, decisions and phase budgets

New Pi /waicc-planning and CLI start sessions record objective planning. Source-backed
planning acceptance produces PLAN_READY; specification-only review produces
SPEC_APPROVED. Neither is permission to build, a task completion count or code PASS.
The human may /waicc-develop [--main|--delegate] to accept the current plan and
authorize development in the SAME session. It needs a current accepted plan or fresh
specification PASS, coherent task/acceptance/path coverage, current requirements and
no pending handoff or failed specification review. No close/reopen/new plan is needed
merely to change the objective. The command creates no round/handoff or external agent.
Do not invoke human develop/decide commands yourself through shell or file editing.

Development authorization is an immutable human record pinned to contract version,
requirements digest and allowed paths. Check implementationAuthorized and its reason,
not just implementationOwner, planApproval or a PASS label. Main is the default coder;
delegation remains optional. New planning reply outcome ready is assessed as plan
acceptance, not the legacy automatic implementation handoff. Stop for the human's
development command if objective/authorization says planning-only or unrecorded.
Ordinary contract/scope revisions invalidate authorization; review-fix revisions do
not automatically inherit it. Reconcile/accept the revision, then request an explicit
human /waicc-develop. Reopening never restores an old grant. Old authorization
artifacts and all prior evidence remain in history.

Authorization and execution readiness are separate. IMPLEMENTATION_GATED means a
human authorized the plan but unresolved choices still gate affected/dependent tasks.
The main agent may do genuinely unblocked in-scope work, not gated behavior. A whole-
plan delegated handoff and final all-done code review require all gates resolved.
Do not turn this into per-task/per-finding manual handoffs or claim partial work done.
READY_TO_IMPLEMENT means the recorded grant matches the plan and no decision gates
remain; task dependency completion and actual test execution must still be checked.
Full code-review PASS leads to READY_TO_CLOSE for development. Specification-only
work may instead be explicitly closed by the human after fresh specification PASS.

/waicc-decisions shows one consolidated brief: owners, investigation evidence,
recommendations, open/deferred answers and affected/dependent task IDs. Each contract
version includes DECISIONS.md. Resolve repository-answerable facts yourself before
escalating genuine human/external choices. The human /waicc-decide <id> <answer>
records an existing gate's answer in a new contract version with an immutable audit,
without changing requirements/tasks/paths or consuming another round. It refuses
pending assignments, unknown gates and replacement of an already established answer.
Identical answers are idempotent. Requirement/scope changes still need /waicc-amend.

A direct human decision resolution can explicitly repin existing plan acceptance and
a CURRENT development grant because that command changes only the existing answer,
status and evidence. It cannot restore missing/stale authority or inherit any review
PASS: the new version requires fresh review. Do not claim a backend answer is true
without appropriate evidence or treat it as production/credential permission.

Status separates objective/phase, planAccepted/planApproval, specificationReview,
codeReview, implementationAuthorized/reason, openGates, reported task progress and
roundBudget. null reportedCompleteTasks means no current whole-work claim, NOT zero
implementation. Counts are source/version-labelled claims; deliveryVerified stays
false. Read all acceptance criteria and evidence for a whole-change code review.
Legacy omitted review kinds display legacy_contract, never silently code; malformed
unknown kinds stay unknown. Stored legacy histories are not retroactively rewritten.

New objective-aware sessions have an explicit overall 20-round cap and phase limits:
specification 8, implementation 6, testing 4, code_review 8, advisor 4. Both caps apply;
switching objective, revising or answering decisions never resets counts. Human
/waicc-limit [phase] <2-20> changes only the selected limit. Existing sessions retain
their previous overall cap and do not gain phase limits implicitly. Consolidate
review findings and resolve genuine blockers instead of silently raising budgets.

Coordinator edit/write tools honor recorded objective, grant, ownership and pending
handoffs. General coordinator shell/host permissions are NOT OS-sandboxed by this
record; never bypass scope/gates through alternate tools. Recipient guards and
per-command test-execution approval remain unchanged. No grant implies production,
installs, resets, commits, pushes or deployment authority.
