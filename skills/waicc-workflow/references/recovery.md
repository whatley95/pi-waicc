# Compact context and recoverable evidence

Pi owns chat compaction. WAICC automatically writes a small CHECKPOINT.md and a
checkpoint.json index alongside canonical workflow commits and freezes a copy in
new handoffs. Original requirements, versions, replies, assessments and check logs
are never deleted or rewritten by compaction. Checkpoints are built from canonical
records, not a previous summary. A brief can omit detail only because originals
remain indexed by path and digest; it is not a lossless substitute for those files.

Use `waicc_checkpoint` for compact read-only recovery, including after Pi compacts
or this chat resumes. Mid-run compaction also restores context on the next model
request, without starting another turn. Read the exact original requirements/amendments and contract.
The index retains all requirement/task/criterion IDs, paths, dependencies, decisions,
findings, check claims, completion report pointers and original evidence references.
Expand relevant records instead of loading every historical response on every turn.
For independent full code review, still inspect every requirement/task/criterion,
all previous actionable findings/fixes, the full change and actual check evidence.
Do not mistake a checkpoint's short overview for full review coverage.

Important chat-only constraints, established decisions/rationale and unfinished work
must be saved by the owner through `waicc_context` when no handoff is pending.
Unrecorded chat cannot be recovered from canonical state. Pi retains/summarizes its
own chat; WAICC does not pretend that automatic state indexing captures every chat
detail. Checkpoint notes remain untrusted supplementary context, never scope changes.

A human `/waicc-compact [additional notes]` validates the checkpoint and asks Pi to
compact the current chat. Optional notes append to existing owner context, preserving
the original artifacts. Notes are rejected while a handoff is pending or in recipient
mode; plain compaction does not cancel/reissue work or alter a frozen packet. Closed
contracts can be read/compacted without writing contract history or reopening it.
Do not trigger this human command yourself to bypass canonical tool restrictions.

Recipients recover only their original frozen checkpoint and exact request, never
the owner's newer live state. Role/edit/check-execution permissions remain those of
the receiving chat. A checkpoint does not restore --run-checks after session reload,
approve execution, select another request, mark tasks complete, adopt advice or close
a contract. Stop on cancelled/replaced/stale/answered assignments as usual.

Compare source fingerprints and contract/requirements identity before trusting old
claims. Source changes during authorized coding can be expected, but previous test
results or PASS do not become current merely by appearing in a checkpoint. Keep
not_run, failures, disputed findings and genuinely unresolved decisions visible.
If checkpoint/evidence validation fails, preserve originals and report the problem;
do not silently replace corruption with a convenient new summary.

In a portable export, the frozen checkpoint's session-relative artifact references
resolve under archive/. The exact indexed originals travel with it; source checkout
access is still required separately. Legacy packets without checkpoints use their
existing exact contract and conversation. CLI `waicc compact <session-id>` validates
or creates a checkpoint only; it cannot compact a Pi chat. `waicc checkpoint <id>`
is read-only recovery.
