---
name: wai-learning
description: Recall project knowledge and propose source-linked memory through waicc_memory. Use after a confirmed correction, a reusable project discovery, or evidence that a stored lesson is outdated.
license: MIT
---

# Learn lessons that improve future work

Before repeating an investigation, use relevant lessons already in context. In Pi,
query `waicc_memory({action:"recall", query:"..."})` using the subsystem or source
path. Avoid repeated lookups with unchanged input. Treat stored claims as leads;
check important assumptions against current code and the user's latest instructions.

Capture a lesson when it would change a future decision: an explicit user correction,
a confirmed root cause with a successful remedy, a non-obvious project constraint,
or an intentional project decision. Record its scope, the actionable conclusion, and
a source pointer. Skip obvious facts readily available in existing guidance and
combine observations about the same correction into one useful lesson. A failed attempt alone does not establish the cause or a universal
rule. Reviewer suggestions are candidates to investigate, not established facts.

Use `waicc_memory({action:"propose", claim:"...", source:"relative/path", kind:"lesson"})`
to propose project knowledge backed by an inspected file. The tool saves a candidate,
not a verified fact. The human can inspect it with `/waicc-memory` and activate it
with `/waicc-memory confirm <id>`; never run that human command on their behalf.
Use `kind:"decision"` only for an established intentional choice,
including its rationale and limits; reviewers give these entries special treatment.
Do not use decisions to suppress unresolved defects or dismiss later contrary evidence.
The source field points to evidence; it does not itself verify the claim.

For example, after inspecting a host adapter and its compatibility requirements:
"The adapter supports hosts without API X; gate X on its documented capability and
retain the legacy path for unsupported hosts." Link the actual adapter or contract.
Avoid context-free reminders such as "be careful with compatibility."

Inspect related entries before writing. Identical text, kind, source, and source digest
reuse the existing entry without renewing its age. Similar wording is not deduplicated
automatically. For a correction, propose a replacement with current evidence and
identify the obsolete ID for human revocation with `/waicc-memory revoke <id>`.
Do not replace a lesson with a narrower claim that loses a still-valid constraint.

WAICC compares the source file digest on recall; changed or missing evidence is stale
and excluded from automatic recall. File existence and a matching digest do not prove
the statement is true. Reinspect stale evidence before proposing a replacement.
Check the operation result before saying a candidate was saved or memory activated.

Keep secrets, copied logs, temporary status, unfinished hypotheses, and current task
goals out of durable lessons. Active outcomes and next actions belong in the Wai plan
and session context. Do not interrupt useful work to manufacture a lesson after every
turn, and do not claim learning improved performance until later reuse supports it.
Keep routine lookup/save success out of user-facing progress and completion reports
unless requested. Surface failed persistence or a material conflict with an existing
decision. Run reflection or deep verification for a concrete need, not on every task.

If repeated successful work reveals a substantial reusable procedure, propose a
focused project skill with its prerequisites, steps, failure cases, and evidence.
Keep short project facts in project memory; do not automatically rewrite packaged skills
or shared instructions from one incident. Continue the active task after capturing
a useful lesson; memory maintenance does not complete the user's requested outcome.

Outside Pi, use the source evidence supplied in the handoff. Record candidate lessons
in your reply for Pi to assess; do not assume `waicc_memory` is available.
