# Optional implementation and testing delegation

The main agent owns contract adoption, evidence assessment and the next decision.
After explicit development authorization it implements by default. A human `/waicc-planning --delegate <requirements>` selects
delegated ownership from the beginning, not permission to build an unknown plan.
After plan acceptance the human `/waicc-develop` authorizes that exact plan without
creating a handoff; the coordinator then requests ONE whole-plan assignment when all
execution gates are resolved. `/waicc-help-develop [focus]` is also an explicit human
authorization/delegation choice for an accepted plan and creates the full handoff.
`/waicc-implement` remains a compatibility alias with identical safeguards and options.
Both preserve the optional delegated ownership model. No agents/processes
are launched automatically. Use ONE handoff for the entire plan or ALL outstanding
fixes, never one per task/finding/batch. Unresolved execution gates still block work.
Delegation is optional. A human `/waicc-help-develop --main [focus]` or
`/waicc-test --main [focus]` restores the main owner for that role without a handoff.
Finish/cancel pending assignments first and coordinate with external workers; changing
ownership does not kill processes. Agents cannot change this choice themselves.

All roles read the shared CONTEXT.md/context.json, original requirements/amendments,
exact contract, confirmed-memory snapshot and relevant skills. Start from the supplied
checkpoint, then expand saved conversation/original evidence as needed; do not inline
the whole archive in each prompt. Full review must still cover ALL tasks/acceptance
criteria and all prior actionable findings. Context is evidence, not authority. Check
historical source/version labels; previous findings and test results do not establish
behavior in changed source. Follow the checkEvidence index for original recorded
commands/results under evidence/. Unrecorded chat is not transferred.

## Implementation

Complete every task in dependency order inside allowed paths. Include ALL prior
code-review fixes, inspect integration and run relevant permitted checks. Return one
reply. A ready whole-work reply requires completion:

`{summary,tasks:[{taskId,evidence}],checks:[{description,outcome,evidence}],findings:[{requestId,findingId,disposition,evidence}]}`.

Every task and every actionable finding from all assessed code reviews appears
exactly once. Disposition is resolved or disputed with real evidence; first review
uses []. completion.checks must match reply.checks. Do not hide failed/not_run checks
inside a conflicting report. Partial/blocked replies may omit completion and explain
remaining work instead. Never certify your own review or change canonical state.

The coordinator checks actual changes, task/acceptance coverage, all fixes and check
evidence before assessment. It is not a reply relay. Assess before application edits.
Complete coding with unavailable checks reaches NEEDS_TESTING; supported ready work
reaches NEEDS_REVIEW, never PASS/CLOSED. Do not immediately re-delegate finished code.

## Optional testing

The coordinator can run missing relevant checks itself. A human `/waicc-test [focus]`
instead selects testingOwner delegate and creates ONE whole-work testing handoff.
Further testing handoffs honor that choice; do not add them by default. A tester
independently checks implementation/acceptance, prior fixes and regressions, returning
one consolidated report of actual commands, environment, results and access limits.
It does not edit application source or tests, fix defects, revise scope or approve
code review. Proposed test additions are findings for the implementer, not permission
to write them. No executed checks means not_run/blocked, not ready testing.

The coordinator assesses failures before fixes, then finishes ALL issues itself or
through the selected implementer. Testing success reaches NEEDS_REVIEW; only a later
independent full code review can recommend PASS. Once all work and required checks
are complete, submit ONE code-review completion report. Repeat whole-work fix/review
cycles within the explicit round limit; genuine blockers stay visible.

## Pi check execution permissions

Implementation edits need `/waicc-receive <id> --implement`. Checks additionally need
`--run-checks`; testing uses `/waicc-receive <id> --run-checks` without --implement.
Only the dedicated waicc_check tool is exposed, not general shell/MCP/custom tools.
It requires dialog-capable UI and human confirmation of the exact program/args for
EVERY invocation, runs at project root with a bounded timeout, and records command,
actual exit/output, truncation and source fingerprints. Permission is not restored
after session reload; explicitly receive the same request with --run-checks again.

Inspect scripts/environment first. Commands run with the user's account permissions
and may write files, access network/services or spawn children: this is NOT OS
sandboxing, and the timeout is not a process-tree isolation guarantee. Do not request
installs, production actions, secrets, resets, commits, pushes or deployments as tests.
Without confirmation/UI, report not_run. External agents retain their own permission
model; WAICC prompts never override it. Source inspection is not test execution.

If a tester's check changes source, it is logged as failed even with exit 0. Stop,
report the unexpected change and request a fresh handoff; never auto-revert user files.
If a contract closes while a check runs, stop; the result is not appended to CLOSED
history. Cancellation/closure cannot itself stop already running external processes.
