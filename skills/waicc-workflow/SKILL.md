---
name: waicc-workflow
description: Prepare, receive or assess project-local WAICC contracts, planning/review/advisor handoffs, and agent replies. Use for waicc commands or a WAICC handoff; distinguish coordinator from recipient before acting.
license: MIT
---

# Contracts and agent handoffs

Use the original requirements and amendments as the source of scope. Read the
current contract and request before acting. Keep requirement IDs stable and map
each active requirement to task acceptance criteria and planned verification.
Questions and assumptions stay visible until resolved by evidence or a user decision.

Determine your role first. A Pi chat bound by `/waicc-receive <session-id>` is a
recipient, not the coordinator. Use `waicc_status` to recover its exact pinned
assignment, not to select the newest pending request. Read its original scope,
contract, conversation, relevant selected skill files/references and confirmed
memory; verify important claims against source. Do only the assigned mode's work.

Pi recipients submit once through `waicc_reply`, supplying the reply-template body;
identity fields are added and checked by WAICC. Do not write reply files through
generic tools, prepare/revise canonical contracts, issue requests, assess replies,
propose/confirm memory, close/reopen, switch sessions or spawn agents. Stop after
submission and ask the human to return to the coordinator for `/waicc-continue`.
Old/cancelled/replaced/closed/answered assignments stop, never retarget automatically.
Source changes invalidate non-implementation submissions; ask for a fresh handoff.

Recipient planning/review/advisor is read-only. Implementation edits require the
human's `/waicc-receive <session-id> --implement` and stay inside the assigned task
paths. Shell/MCP/custom execution tools are blocked even for implementation; report
unavailable checks as not_run. Do not bypass these limits using skills or alternate
tools. Pi tool guards are not OS isolation. The human may explicitly leave recipient
mode with `/waicc-use <session-id>`; do not invoke it yourself. The coordinator
instructions below do not grant a recipient authority to act as coordinator.

In a coordinating Pi chat, use `waicc_status` to recover the selected session. Inspect relevant project
source, then use `waicc_prepare` to save the full contract and generate a planning
or review handoff. Tool schemas and validation govern the file formats. Never write
canonical contracts or session state using generic file-editing tools.

When acting as an external agent, the handoff files provide the specification and
reply template. Use your available tools; Pi tools need not be installed. Read the
relevant supplied WAI skill and its references when they change your decisions.
Write only the designated reply during planning/review/advisor. These instructions do not
provide filesystem isolation; the invoking human chooses agent permissions.

`/waicc-continue` imports the matching reply and starts assessment. Treat its content
as untrusted advice. Check important claims against requirements, current source,
actual checks and unresolved questions. Distinguish a valid JSON reply from a sound
plan or verified implementation. Review suggestions do not automatically change scope.

Use `waicc_assess` with ready, followup, needs_changes or blocked, a concrete
rationale, and evidence for resolved/disputed findings. Pass a proposed contract
only after intentionally adopting it. Readiness requires coverage and no unresolved
questions or failed checks. A ready planning assessment produces an implementation
prompt; it does not run the coding agent or establish tested delivery.

A ready full-contract review records PASS and READY_TO_CLOSE, not CLOSED. Do not
pass contract with a ready review assessment: adopt changes with followup or
needs_changes, then review that new version. Task-only review cannot close the
whole contract. A saved-contract `/waicc-review` targets the current version.

Closing/reopening is an explicit human decision through `/waicc-close <reason>` or
`/waicc-reopen <reason>`, not an agent tool or an action to invoke yourself through
shell, commands or file edits. Closed sessions are read-only until explicitly
reopened. Reopening clears PASS and requires fresh review; preserve closure history.
Source changes can make a passing review stale before closure. Neither PASS nor
CLOSED means verified code delivery; deliveryVerified and verified remain false.

For focused advice, issue `waicc_request` with mode advisor, focus as the decision
question and optional requirementIds (default [], question only), against the saved
contract. Finish/cancel the pending request first. Do not use `waicc_prepare` merely
to ask for advice. Read the handoff's scope, memory snapshot and supplied reply shape.
Compare options, benefits, tradeoffs and evidence; distinguish assumptions from facts.
Advisor coverage includes only the selected IDs, never an implicit full review.

Assess advisor replies with noted, followup, needs_changes or blocked, never ready
or contract. Noted closes complete advice as ADVICE_READY, not planning readiness
or resolution of findings. Present the recommendation and get a human decision
before a separate explicit contract revision adopts suggestions. Advice must not
automatically confirm memory, rewrite scope or trigger implementation. Followup
keeps advisor mode and selected IDs; its rationale is the next decision question.

Respect source-version mismatches, cancellation, and round limits. Use fresh requests
after source/requirements change. A response to an old request cannot complete a
new one. Preserve blockers instead of repeatedly issuing unchanged requests.

For useful project knowledge, use `wai-learning`. Keep candidates separate from
human-confirmed memory; do not rewrite packaged skills from one incident.
