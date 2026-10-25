# WAICC protocol v1

The authoritative contract is JSON. Its Markdown is generated from the same data.
Requests/replies use schemaVersion 1. Unknown reply/contract fields are rejected,
except finding annotations preserved by the compatibility layer described below.
The extension controls generated IDs, paths, input fingerprints and journal writes.
Agent output is data, never a shell command or permission to change scope.

## Objective, development authority and decision transitions

New Pi/CLI sessions persist objective planning (or review for a new standalone review),
an overall 20-round cap and phase caps: specification 8, implementation 6, testing 4,
code_review 8, advisor 4. Low-level createSession accepts optional objective; omission
retains legacy behavior/default 12-round cap. Stored older sessions are not rewritten
or silently given larger budgets. Round.phase is persisted for new rounds; old phase
usage is classified from its explicit mode/kind, with legacy reviews specification-only.
Both overall and phase caps apply. Human /waicc-limit [phase] <2-20> updates only the
selected cap; transition/decision commands never create a round or reset usage.

Plan acceptance, specification approval and implementation authorization are distinct.
New objective-aware specification review ready -> SPEC_APPROVED, while code review
ready -> READY_TO_CLOSE. Legacy spec records can retain READY_TO_CLOSE, but status
labels them specification-only and advertises /waicc-develop, not just closure. New
planning ready assessments mean PLAN_READY, not the legacy implementation handoff.
Planning-only SPEC_APPROVED may be explicitly closed; development cannot close on
specification PASS. New reviews always persist kind. Display missing legacy kind as
legacy_contract and malformed kinds as unknown, never silently code.

Human /waicc-develop [--main|--delegate] accepts the current plan and changes objective
to development. Preconditions: open session, no pending request, coherent readyPlan,
current requirements and either acceptedPlanCurrent or a fresh current specification
PASS, without an outstanding failed specification review. It writes immutable
authorizations/<id>.json and implementationAuthorization pinned to contract version,
requirements digest and allowed-path digest, with source baseline/provenance. It
creates no handoff, round or process; repeated current grants are idempotent. Human
/waicc-help-develop is also explicit authority/delegation for an already accepted plan.
/waicc-implement remains a compatibility alias; it does not change authority or scope.
Agent tools cannot grant authority; commands/CLI are human entry points, not actions
for a model to invoke through general shell/file tools.

implementationAuthorized describes the exact grant, NOT execution readiness or
completion. READY_TO_IMPLEMENT has no open gates; IMPLEMENTATION_GATED carries a
valid grant with affected/dependent tasks still blocked. Main may complete genuinely
unblocked scoped work; whole-plan implementation handoffs and all-done code reviews
still require readyContract (all gates resolved). Every ordinary version/scope change
makes the grant stale. Reopening clears the active grant; history remains immutable.
Coordinator edit/write guards check objective, grant, owner and pending assignments;
they are not OS/shell isolation, and never grant production or credential permissions.

/waicc-decisions exposes a consolidated brief including recommendation/evidence,
owner/status and affected/unblocked task IDs. Every new contract version includes
DECISIONS.md. Human /waicc-decide <id> <answer> changes only an existing unresolved
decision's status/answer/evidence in a new contract version and decisions/<id>.json
audit; original requirements, tasks and paths are unchanged. It rejects pending work,
unknown IDs, conflicting re-answers and CLOSED sessions. Exact repeated answers are
idempotent. Requirement/scope changes still require amendments. This narrow explicit
human action may repin existing acceptance/current authorization, but never resurrects
missing/stale authority or carries specification/code PASS to the new version.

Status/checkpoints expose objective/derived phase, planApproval plus computed legacy-
aware planAccepted, authorization plus reason, separate specification/code review
evidence, open gates, and source/version-labelled reported task counts. Unknown count
is null, not zero or verified. Hash/identity pins do not prove implementation or that
checks ran; deliveryVerified remains false. Checkpoint/export archives retain grant,
decision audit and decision brief originals with their digests.

## Compact checkpoints and recovery

Session.checkpoint optionally identifies immutable JSON/Markdown artifacts and their
canonical sequence. Workflow commits atomically write a new deterministic checkpoint
alongside state/artifacts; local check start/result commits do the same. Existing
artifacts are never rewritten. The projection reads original canonical requirements,
contract and journal state, not an older checkpoint. A new round.checkpointVersion=1
freezes CHECKPOINT.md/checkpoint.json in that request. Later assessments/checkpoints
never change those issue-time bytes. Legacy rounds are not retroactively rewritten.

checkpoint.json records every requirement/task/acceptance/dependency/path mapping,
decision ID/state, historical finding identity/disposition, failed/passed/not_run check
claim, completion/assessment pointer, owners, approvals, requirement digest, recorded
source fingerprint and an exact original-artifact path/hash index. It does not infer
completed tasks or promote a reply claim to verified evidence. Decisions/constraints,
rationale and full check evidence remain in the referenced originals. CHECKPOINT.md
is a bounded recovery brief, not a substitute for the exact requirements/contract or
the index. Large histories are expanded on demand. Full code review still covers
all requirements/tasks/criteria and all earlier actionable findings/fixes.

waicc_checkpoint is read-only. It validates checkpoint hashes/canonical projection
and referenced originals, reports current-source comparison and exposes exact paths.
Source drift does not mutate status or invalidate an accepted plan merely by reading;
it does prevent treating historical checks/PASS as proof for changed code. New source
approval and intake freshness rules remain unchanged. Before-agent recovery performs
the lighter projection/brief check; compaction/tool recovery also verifies originals.
Recipient recovery validates only its exact frozen request and never selects the
owner's newer checkpoint, restores check permission on reload or grants new tools.

Pi owns transcript compaction/retention. WAICC's session_before_compact hook validates
recoverability (cancels on errors) and leaves Pi's compaction implementation/threshold
unchanged; before_agent_start reloads the compact checkpoint.
session_compact also marks an ongoing run for request-local context recovery,
covering threshold/overflow retries before another before_agent_start occurs.
The context hook inserts/replaces only WAICC's own recovery message, does not persist
or rewrite the transcript and never starts a turn. Normal per-run recovery resets it.

/waicc-compact [notes] requires an idle trusted chat, validates evidence and requests ctx.compact with
instructions to preserve chat-only constraints/decisions/rationale, unfinished work,
actual checks/limits and next action. Pi completion/failure callbacks distinguish a
request from successful compaction. No new model turn, handoff, approval or closure
is triggered. Optional notes append to owner context only when no handoff is pending.
Human cancel/force-close cannot be obstructed by damaged contract/observed-source
artifacts needed only for checkpoint generation. Their checkpoint records projection
errors, preserves the damaged originals and refuses recovery/compaction until the
evidence is addressed; stopping never repairs, approves or hides that damage.
Without notes, pending packets stay untouched. CLOSED recovery/compaction writes
nothing and never reopens a contract. Uncaptured chat cannot be reconstructed by a
canonical-state index; use waicc_context when allowed and Pi's retained chat/summary.

CLI checkpoint is read-only and compact validates/creates only the checkpoint, not
chat compaction. Checkpoint refresh is idempotent when current and valid. Portable
exports copy the frozen checkpoint unchanged and every indexed original byte-for-byte
under archive/; its session-relative artifact paths resolve there. No source checkout
is included. Existing legacy handoff export/recovery behavior remains available.

## Contract body

Pass this body to `waicc_prepare` or the CLI `prepare` command. Metadata such as
session ID, source evidence and version is added by the engine.

```json
{
  "title": "Customer search",
  "requirements": [
    {
      "id": "REQ-001",
      "text": "Search only permitted customers",
      "sourceQuote": "Add customer search"
    }
  ],
  "exclusions": ["Deployment"],
  "assumptions": [],
  "questions": [],
  "risks": ["Customer authorization"],
  "tasks": [
    {
      "id": "API",
      "title": "Define and implement the search boundary",
      "requirementIds": ["REQ-001"],
      "dependsOn": [],
      "allowedPaths": ["src"],
      "acceptance": [
        {
          "id": "AC-001",
          "text": "Cross-account requests reveal no customer data",
          "requirementIds": ["REQ-001"],
          "verification": "Run positive and negative authorization integration tests"
        }
      ]
    }
  ],
  "skills": ["wai-api-contracts", "wai-security", "wai-testing"]
}
```

This example requires the exact quote `Add customer search` to occur in the original
request or an amendment. Quote validation preserves provenance but cannot establish
that a paraphrase includes every nuance; Pi must assess semantic coverage. Empty
tasks/acceptance are permitted in unresolved planning drafts, but not in a ready
implementation contract. All referenced IDs must exist; dependency cycles and unsafe
relative paths are rejected. Existing requirement IDs and quotes cannot disappear.
For a requirement withdrawn by the user, preserve its provenance and explain the
supersession in the revised requirement/acceptance text and amendment. V1 does not
provide a separate superseded-requirement lifecycle.

## Source-first planning and decision gates

The coordinator owns scope, evidence checks, intentional adoption, decision carry-
forward and question triage. A first planning contract may be a requirements/context
brief with tasks [], not a speculative full plan. The recipient investigates source,
tests/docs/history and accessible references and returns the detailed proposedContract.
Escalate only genuine unavailable human/external choices with recommendations and
evidence. Reversible technical assumptions stay explicit; product changes, credentials,
security and production authority are never inferred. Avoid unchanged question loops.

Optional `contract.decisions` entries:

```json
{
  "id": "DEC-001",
  "question": "Which client presentation does the owner want?",
  "owner": "human",
  "status": "deferred",
  "affectedTaskIds": ["CLIENT"],
  "evidence": [
    "Source establishes the API but does not specify the presentation choice."
  ],
  "recommendation": "Keep existing presentation until the owner chooses; gate CLIENT."
}
```

owner is agent/human/external; status is open/resolved/deferred. Affected IDs must
be nonempty, unique and known tasks. Evidence and recommendation are required.
resolved requires answer; open/deferred cannot carry a claimed confirmed answer.
Decision IDs/questions survive revisions. Answers/evidence are claims for the owner
to check, not engine-authenticated approval. Status decisionGates exposes pendingDecisions,
decisionBlockedTaskIds and decisionUnblockedTaskIds, propagating gates through dependsOn.
Unblocked is not implemented/tested/dependency-complete or authorized to execute.

Only planning replies/assessments may use planned. The owner can assess a planned/ready
planning reply as planned, intentionally adopting the complete contract with
assessment.contract when needed. Acceptance still requires task paths/acceptance for
every requirement, no specification-blocking questions, addressed coverage, no failed
checks and high/critical dispositions. Agent-owned unresolved decisions must first be
investigated. Future human/external decisions may remain on affected tasks. Success
sets PLAN_READY and creates no request/implementation handoff. Not-run checks stay
not_run. Planning addressed is source-backed specification coverage, not delivery proof.

Do not silently erase blockers or relabel defects as future decisions just to pass.
Specification-only review ready and explicit closure can accept a complete specification with documented
future gates; they never resolve those gates or authorize execution. All freshness,
coverage and review re-checks remain. Legacy planning ready still uses execution-ready
validation (all decisions resolved) and creates an implementation handoff. Existing
replies are not automatically reclassified or promoted to planned.

## Manual delivery instructions

New round `STARTER.txt` files contain a complete copyable recipient prompt with the
project, session/request/version, role boundaries, handoff and reply/template paths,
required linked inputs, and stopping conditions. Copy the **contents**, not merely
the filename or a coordinator status/assessment message. It is not a shell script.
The recipient reads `HANDOFF.md` and its linked files; the human need not separately
paste the contract, assessment or conversation when those paths are accessible.

For an unanswered WAITING request, single-session status exposes `manualHandoff`
before the potentially large requirements/contract. It includes copyPastePrompt,
whatToSend/notNeeded, differentMachine guidance and separate human return commands.
Pi tool results give the agent only `{requestId, prompt, afterReply,
resumeCoordinatorCommand, continueCommand}`, where `prompt` says the prompt is not shown
to it, so the agent cannot paste it into the chat; the clipboard copy and
`/waicc-handoff` still use the full text. `/waicc-handoff [session-id]` renders a clearly delimited copy-only prompt followed
by those return steps without inference, new artifacts or a role/session switch.
It uses the existing selected session unless explicitly given an ID. An explicit
ID only selects the view, not the coordinator binding; select the correct session
with `/waicc-use <id>` before intake if needed. Existing pending rounds receive the
new display instructions from their original pins without rewriting committed files.

Any existing reply.json withholds the copy view, even before intake; status reports
pending.replyExists and recommends coordinator /waicc-continue instead of duplicate
work. Received/cancelled/closed rounds do not expose a manual copy view. This is a
delivery aid, not a worker reservation, source-freshness verdict or OS permission.

If the recipient lacks access to the same project paths, export the pending round
and send the **whole export folder**, including its portable STARTER.txt and linked
inputs, plus access to matching source separately. Export excludes source code.
The recipient writes reply.json beside the exported HANDOFF.md; the human returns
it to manifest.returnReplyTo before coordinator intake. Review content before
sharing. Do not send only a HANDOFF.md attachment or the origin's inaccessible paths.

## External reply

Start from the generated `reply.example.json`; its identity values are real and
must remain unchanged. Save the completed object as `reply.json`, not a fenced block.

- `schemaVersion`, `sessionId`, `requestId`, `contractVersion`, `requirementsDigest`,
  `sourceFingerprint`, `mode`: pinned request identity. Modes are planning, review,
  implementation, testing and advisor.
- `outcome`: `ready`, `planned` (planning only), `needs_changes`, `needs_clarification`, or `blocked`.
- `summary`: the actual result.
- `coverage`: exactly one `{requirementId,status,evidence}` row per requirement.
  For advisor, only the explicitly selected IDs are covered (default `[]`).
  Status is `addressed`, `missing`, or `unverified`.
- `findings`: `{id,severity,description,evidence,suggestedFix?,extensions?}`. Severity is critical,
  high, medium, low, or info. IDs are unique within the reply. `extensions` optionally
  holds untrusted annotation fields; it does not change scope or workflow decisions.
- `questions`: unresolved questions, or `[]`.
- `checks`: `{description,outcome,evidence,extensions?}`. Outcome is passed, failed or not_run.
  Description/evidence are nonempty strings; extensions are inert JSON annotations.
  Do not describe a planned check as passed.
- `proposedContract`: optional complete contract body, offered for explicit adoption;
  forbidden for advisor replies, which suggest amendments as text instead.
- `advice`: required only for advisor replies; see below. Rejected in other modes.
- `completion`: whole-work implementation report {summary,tasks,checks,findings};
  implementation only. New delegated ready replies require every task and every
  previous actionable code-review finding exactly once; checks must match reply.checks.

Replies to another request/version are rejected. Matching planning/review/testing/advisor replies
whose source changed are archived as stale. An implementation may change source;
its observed post-implementation source is pinned at intake. Any subsequent source
change invalidates assessment. Repeated intake cannot replace an already frozen reply.
After fixing stale inputs, issue a fresh request with a new ID.

### Flexible finding intake

Both manual replies and `waicc_reply` accept these common external-agent variants:

- Missing `id`: assign a deterministic `F-001`-style ID, skipping every explicitly
  supplied ID (including later findings). Explicit duplicate/invalid IDs still fail.
- `findingId`: alias for `id`; conflicting values are rejected.
- Missing `description`: use `title`, or `message` if title is absent. When a
  description already exists, other wording stays visible as an annotation.
- Severity casing/whitespace: normalize to lowercase, but never guess missing
  severity or reinterpret an unknown priority such as P1 as a severity.
- `evidence` as a text array: join with newlines; empty/malformed evidence fails.
- Extra finding fields: preserve under `extensions`, including file, line,
  recommendation or agent-specific annotations. Conflicts with an explicitly
  supplied extension key fail rather than overwrite information.

For example, `{"severity":"Medium","title":"Concern","evidence":["REQ-001","file:12"]}`
becomes `{"id":"F-001","severity":"medium","description":"Concern","evidence":"REQ-001\nfile:12"}`.
This does not manufacture evidence, repair identity, promote coverage or hide failures,
relax proposed-contract validation, execute annotations or accept a proposed change.
The canonical validator remains strict after this transport conversion. Prefer the
canonical format in new replies; this is compatibility, not arbitrary free-form intake.

### Flexible check, coverage and decision intake

Transport normalization version 2 additionally supports:

- Check outcome `pass`, `success`, `succeeded` → `passed`; `fail`, `failure` →
  `failed`; `notrun`, `not_executed`, `not_attempted`, `skipped` → `not_run`.
  Canonical outcomes and aliases accept casing, surrounding whitespace, spaces
  or hyphens in place of underscores. No other outcome is guessed.
- Check `status`/`result` as aliases for `outcome`. Multiple result fields must
  normalize to the same result; a pass/failure conflict is rejected.
- Missing check `description` can use `name`, `check`, or `command`; missing
  `evidence` can use `details` or `output`, in that precedence order. Remaining
  annotations, including unused aliases, stay under optional `extensions`.
  Extension-key collisions fail rather than overwrite data. Command text is
  description/provenance only, never executed.
- Check and coverage evidence arrays join nonempty strings with newlines.
  Proposed-contract decision evidence as one nonempty string wraps into a
  one-item array, without splitting text, inventing answers or changing task IDs.
- Top-level reply outcomes, coverage statuses, and proposed decision owner/status
  accept casing/spacing/separator variants only of their existing canonical
  words. No `PASS` → `ready`, `verified` → `addressed`, or `approved` → `resolved`.

Checks still need a description, actual evidence and one unambiguous result.
`unknown`, `pending`, `blocked`, `error`, booleans and missing outcomes are not
silently converted to success or not_run. The error identifies the indexed field
and canonical choices. All required root arrays, request pins, coverage rows,
requirement quotes, task references, decision rules and source freshness remain
validated. No normalization creates approval, adoption, execution permissions or
verified delivery. Unknown root/proposed-contract fields still fail validation.

At coordinator intake, `received.json` retains the original reply bytes and
replyDigest still hashes those bytes. The journal's round.reply is the normalized
canonical view. When conversion occurred, `received.normalized.json` and
`reply-normalization.json` are committed alongside it; the latter records normalizer
version and conversions. Version 2 applies only to new intake; older frozen rounds
remain unchanged. Status and subsequent conversation expose replyNormalization
and canonical finding IDs for assessment/dispositions. Repeated intake never
rewrites an already frozen reply, generated IDs or its conversion history. Legacy
received rounds are not re-normalized. Normalized review artifacts are also checked
for modification before closure.

`waicc_reply` validates the same conversion before writing, reports conversions in
its result, and preserves supplied fields in the submitted reply.json.
Only coordinator intake creates the frozen raw/normalized/audit artifacts. Missing
severity, evidence or usable description still requires a corrected reply; request
pins, coverage, freshness, high/critical dispositions and human closure rules remain
unchanged. Nothing is automatically adopted into the master contract.

### Clipboard delivery

Interactive TUI creation of an unanswered handoff attempts to copy only its recipient
prompt through Pi's public copyToClipboard utility. Automatic copies are deduplicated
per request/chat; ordinary status/use reads do not write the clipboard. Explicit
/waicc-handoff always retries copying. Export copies its portable starter rather
than the origin's inaccessible local paths. Clipboard failure does not roll back the
request: UI/tool details report the failure and retain a visible manual copy block.
RPC/JSON/print contexts never call the writer, even when they expose UI dialogs;
terminal clipboard sequences must not corrupt their protocol output. Native platform
and terminal permissions still apply. Remote OSC 52 cannot be independently confirmed;
the host's success is a delivery attempt, not a verified client clipboard readback.

## Pi-native recipient transport

`/waicc-receive <session-id> [--implement] [--run-checks]` is a human command in a manually opened,
idle, trusted Pi chat in the same project checkout. It requires exactly one WAITING
round with no reply file, and source matching that request. It does not create a
WAICC session/round or mutate its journal, status or updatedAt. Pi's current model
receives the assignment; no model switch, subprocess or scheduler is involved.

The Pi chat persists role recipient plus a pin of sessionId, requestId,
contractVersion, requirementsDigest, sourceFingerprint and mode. Resume restores
that pin and recipient tool profile. Assignment recovery reads the exact committed
contract version, handoff, template and conversation, selected skill paths, and
the issue-time confirmed-memory snapshot for new contextVersion 1 requests (legacy
requests without a snapshot retain their old recall behavior). It never chooses a replacement/newer request.
Cancellation, amendment, replacement, intake or closure invalidates the binding.
An existing reply makes it stop. Per-tool guards check request metadata; full source
fingerprints are checked at receive and submission, not on every read.

`waicc_reply` accepts `{reply: <body or complete reply>}` only in recipient mode.
The engine supplies the pinned identity fields; any supplied identity must match.
Both transports share reply validation, including exact coverage, advisor question
and proposed-contract rules. A project writer lock protects validation and exclusive
creation of the designated UTF-8 `reply.json` (maximum 256 KB); an existing file is
never replaced. Non-implementation submissions also require unchanged source.
Implementation may change source; ordinary coordinator scope/freshness validation
still applies. Submission records provider/model metadata in the Pi chat, not as an
agent-controlled claim in the reply. It does not import or assess the reply, change
readiness, adopt a proposal or close a session. The recipient stops; the coordinator
runs `/waicc-continue` for ordinary intake and assessment.

The active tool profile is read/grep/find/ls, memory recall, status and reply.
Coordinator mutations are also rejected inside their tool callbacks. A tool-call
guard blocks all other tools, including shell, MCP and custom execution, and stops
work on an invalidated/already answered pin. Only explicitly opted-in implementation
enables direct edit/write: each path must stay within the pinned request's task
allowedPaths, excluding reserved runtime/VCS paths and symlink/junction components.
Optional --run-checks for implementation/testing exposes only waicc_check, never a
general execution tool. It needs dialog-capable UI and human confirmation for EACH
exact program/args, runs at project root with a 1000–60000 ms timeout, and logs start,
exit/output (bounded, with truncation flag), cancellation/timeouts and source before/after.
Confirmation is rechecked against the same pin/source; denied/no-UI checks do not run.
The opt-in is deliberately NOT restored from saved Pi bindings. Test source changes
make the result failed even with exit 0, invalidate submission and require a fresh
handoff; there is no automatic revert. A check finishing after CLOSED does not append
results to closed history. Running processes/children are not isolated or revoked by
contract cancellation/closure; commands may affect files/services with account permissions.
No production, installs, resets, secrets or deployment. Missing execution permission
means not_run, never an inferred pass. General shell/MCP/custom tools remain blocked.
This is a Pi extension boundary, not an OS sandbox against user actions, trusted
extensions or external programs. External recipients retain their own permissions.

`/waicc-use <session-id>` deliberately leaves recipient mode for coordinator mode
and restores the previous active tool selection. It is a human role change, not a
model tool. Old role-less Pi binding entries remain coordinator-compatible.
Receiving is not a lease: multiple chats can investigate the same request, but only
the first reply file can be submitted. Choose one worker per request manually.

`waicc_reply` with `validateOnly: true` applies every submit-time check, including
identity, source freshness, coverage and the 256 KB limit, and writes nothing.

## MCP recipient transport and headless dispatch

`waicc mcp` serves newline-delimited JSON-RPC over stdio (MCP protocol versions
2024-11-05 through 2025-11-25) with no dependencies. It exposes `waicc_receive`
`{sessionId, requestId}`, `waicc_assignment`, `waicc_validate_reply {reply}` and
`waicc_submit_reply {reply}`. Receive applies the Pi receive rules (exactly one WAITING
round, no reply, matching source) and additionally requires the supplied request ID to be
that waiting round. It refuses implementation assignments, because an external agent's
own edit tools cannot be confined to task paths, unless dispatch started it with
`--implement` for an agent coding in an isolated worktree (see below). One server process holds at
most one pin and never retargets. Validation and submission use the same engine as
`waicc_reply`; tool failures return `isError` results so the agent can correct and retry.
`--session <id> --request <id>` restricts a server to one request. Planning and review
assignments include `proposedContractExample`, a minimal contract that passes validation.
Reply and contract validation collect every independent problem with its location (for
example `proposedContract.tasks[0].acceptance[1].verification`) and report them together:
one problem reads `<location>: <message>`, several read `<n> problems; fix all of them:`
followed by a numbered line each. A check that later checks depend on stops only those:
a field that is not a list skips its entries, task dependency cycles are checked only when
every task is valid, and acceptance references are judged only against valid task
references. Reply identity and pinned inputs are still checked first, alone. After the reply
itself, coverage, the advisor question, `proposedContract`, completion and readiness checks
are collected together; when `proposedContract` has problems, the example follows them.

`/waicc-dispatch` and `waicc dispatch` are explicit human actions. They accept only a
single WAITING planning, review or advisor round, or an implementation round with
`--implement` (Pi, Claude or Codex), with no reply, unchanged source and no unfinished
dispatch for that round. A testing round additionally needs at least one pre-approved check.

`--check "<command>"` (repeatable, at most 10) pre-approves one exact program and argument
list; single quotes group an argument with spaces. `--check-timeout` sets 1–30 minutes per
check (default 10; interactive checks stay capped at one minute). Checks apply only to
testing and implementation rounds and are recorded in `start.json`. Claude and Codex
receive them through the pinned MCP server (`--checks <file>`, a per-run file removed after
the run, plus `--check-cwd <worktree>` for isolated implementation); `waicc_run_check {check}`
runs one by number through the ordinary recipient check engine, so each run writes
`checks/<id>/start.json` and `result.json` with exit code, bounded output and source before
and after (`ranIn: "isolated worktree"` when it ran in the copy); testing runs that change
source fail. Pi receives them as `WAICC_DISPATCH_CHECKS`, and `waicc_check` runs an exact
match without a dialog; any other command still needs `--run-checks` and per-command
confirmation, which a headless run cannot give. Antigravity cannot receive checks.

Every recipient check (pre-approved or confirmed, Pi or MCP) reads the user file's `sandbox`
(a project file setting it is rejected): `checks` `off` (default), `auto` or `required`;
`network` (default false); `allowWrite`, at most 20 absolute or `~/` folders. Off runs the
exact command as before. Otherwise the writable folders are the check's working folder,
`os.tmpdir()` and `allowWrite`, each also by its resolved path. macOS runs
`/usr/bin/sandbox-exec -p <profile> <program> <args>`; the profile allows everything except
file writes outside those folders and standard devices, and without `network` denies IP
traffic in and out. Linux runs `bwrap --die-with-parent --new-session --ro-bind / / --dev /dev
--proc /proc --bind <folder> <folder>… [--unshare-net] --chdir <cwd> -- <program> <args>`,
used only when a probe run of bwrap succeeds. Elsewhere, or when the probe fails, `auto` runs
the check unsandboxed with `sandboxNote` in its result and next action, and `required` refuses
before `start.json` is written. `start.json` and `result.json` record
`sandbox: {backend, network, writable} | null`.

Agent profiles are read from `$PI_CODING_AGENT_DIR/waicc-agents.json` (default
`~/.pi/agent`) and then `<project>/.pi/waicc-agents.json`, which wins for any profile or role
both define. The only keys are `profiles` (`name → {via, model?, effort?, timeoutMinutes?, fallback?}`, effort mapped to Claude `--effort`, Codex `model_reasoning_effort`, Pi `--thinking` or Antigravity `--effort` and checked against that agent's levels) and
`roles` (`planning|review|advisor|implementation|testing → name | {profile, checks?,
checkTimeoutMinutes?}`); anything else, an unknown agent or an undefined profile is
rejected with its file. Dispatch arguments may start with a profile name; with no name
and no `--via`, the waiting round's mode selects the role's profile. Typed settings
override the profile, and typed `--check` replaces the role's checks. A config cannot
grant `--implement`. Role checks from the project file must be confirmed: Pi shows them
in a dialog and refuses without UI; the CLI requires `--confirm-checks`.

A profile's `fallback` must name another defined profile, not itself. Every dispatch
`result.json` (and the Pi outcome message) records `limit: {kind, text} | null`, set only
when no reply was submitted and the run was not killed: `kind` is `signin`, `usage`, `rate`
or `missing` (the last only when stdout is empty), from the first matching line of the last
4000 characters of stderr and, from the last 40 stdout lines, plain-text lines and error
fields of JSON events (Claude `result` with `is_error`, `*error*`/`*failed*` event types, a
Pi assistant `stopReason: "error"`, `error`/`errorMessage` fields); tool results and the
agent's own messages are not read. In Pi, when a run launched with a profile ends that way,
was not stopped, and was not itself a fallback, the same options are dispatched again with
the fallback's `via`, `model` and `effort` (and its `timeoutMinutes` if set), announced as a
`waicc-dispatch-fallback` message and run notice. The retry's plan and `result.json` carry
`fallbackFrom: {profile, dispatchId, reason}`, and its live label adds `fallback for
<profile>`. A loop adds the profile to its `limited` list, and each later launch in that run
with a listed profile uses its fallback directly (`dispatchId: null`). An in-place
implementation run (no isolation) is retried only if the source fingerprint is unchanged
since its launch. The CLI and advisor consults do not retry.

`--continue` (or a user-file `"autoContinue": true`; `--no-continue` overrides; a project
file that sets it is rejected) runs the ordinary continue step after a dispatch whose reply
exists: intake validation, then the main agent's assessment prompt, delivered as a
follow-up after any current turn. The dispatch is released before that prompt is sent and
the prompt is not awaited, so the main agent's turn runs on its own. `--loop [1–8]`
(default 3; implies `--continue`; Pi only) requires a waiting code review. Each assessment
prompt carries a loop note: fix ALL actionable findings inside authorized scope, run checks,
request ONE fresh whole-change code review in the same turn, or explain and stop when a
finding needs a human, is disputed, blocked or out of scope; never close, commit, push or
deploy. On each `agent_end` while the loop is assessing: a still-`AWAITING_ASSESSMENT`
session keeps waiting; `READY_TO_CLOSE` or `contractReview: PASS` ends the loop as passed; a
new WAITING review is dispatched with the same options if cycles remain, or left waiting at
the limit; anything else ends the loop for the human. A reply whose finding descriptions
equal the previous cycle's ends the loop, and that reply is assessed without the loop note.
No reply, a launch error or `--stop` ends it too. Loop state lives in the Pi process.

`--loop` also accepts a waiting planning handoff. Its note asks the main agent to accept an
acceptable plan (`planned`), use `followup` with exactly what the next round must address
when the planner can fix it (assessment then creates the next planning round), or record a
human decision and stop. `PLAN_READY` ends a planning loop; a new WAITING planning round is
dispatched if cycles remain. `--develop` (planning only; implies `--continue`; alone it is a
single planning cycle) then calls `beginDevelopment` with origin `human-dispatch-develop`
and sends the `/waicc-develop` instruction, unless any decision is still open, in which case
the run stops and lists them. `--review` (or `--review-with <profile>`, needs `--develop`)
keeps the run in a developing phase: on each `agent_end`, a WAITING whole-change code review
is resolved with that profile, or the review role's, plus `--loop <same cycles>`, checked for
authorization and main ownership, and launched as a review loop; another handoff type ends
the run; no waiting handoff keeps waiting. Review-role checks from a project file end the run,
since they need confirmation.

`--code-with [profile]` (needs `--develop`) is checked before the first dispatch: the profile,
or the `implementation` role's when none is named, must exist and must not be `via: agy`.
When the plan is accepted, `beginDevelopment` records implementation owner `delegate`, and
the main agent is asked for ONE whole-plan implementation handoff. On each `agent_end`, a
WAITING implementation round is dispatched with that profile plus `--implement --continue`
(isolated worktree), and a WAITING whole-change code review with the review profile plus
`--continue`. Coding rounds and reviews are each limited to the loop's cycles. The
implementation note forbids the main agent to edit application code; the review note asks it
to request ONE implementation handoff covering ALL actionable findings, or nothing when a
finding needs the human. The run ends at `READY_TO_CLOSE` or a passing code review, when the
main agent asks for nothing new, on any other handoff type, on implementation-role or
review-role checks that need confirmation, and on the budget.

`--review-once` (needs `--develop` and `--review`) limits the run to one code review. Its
review note asks the main agent to assess and stop, without fixes or another handoff; the
run then ends. With `--code-with`, an implementation handoff requested after that review is
left WAITING for the human, never dispatched.

Decisions may carry `risk` (low|medium|high) and `reversible` (boolean), rated by the
planner. The user file may set `policies` (at most 20 rules of 1–500 characters) and
`autoDecide` (`off` | `low-risk`); a project file setting either is rejected. Policies are
appended to the coordinator's instructions; `waicc_apply_policy {sessionId, decisionId,
policy, answer, rationale}` (coordinator only) resolves an open `human`-owned decision,
refusing external and agent-owned ones and unknown policy numbers, with the policy text
and rationale in the decision evidence and a record whose `recordedBy` is
`standing-policy`. With `autoDecide: low-risk`, after each `waicc_assess` and on
`/waicc-develop`, every open decision that is human-owned, `risk: low`, `reversible: true`
and whose question and recommendation match no sensitive subject (access, credentials,
staging/production, deploy, money, delete/migrate, security, permissions, privacy, legal)
is resolved with its recommendation, `recordedBy: auto-low-risk`. A pending handoff stops
the pass until the next one. Both are announced to the human; `/waicc-decide auto` runs
the pass on demand and reports why each remaining decision still needs the human.

`waicc_ask_advisor {question, tried, evidence?, paths?}` (coordinator only, trusted project)
is a consult, not a round: it needs no session, issues no handoff, and changes no contract,
decision or authorization. It runs the advisor role's profile in the project root read-only
(Claude: Read/Grep/Glob only, no MCP; Codex: `--sandbox read-only`; Pi: `-ne --no-mcp
--tools read,grep,find,ls`) with a one-line prompt pointing to `.pi/pi-waicc/consults/<id>/brief.md`,
and returns the agent's final text; `result.json` beside it keeps the answer and progress.
When the chat is bound as coordinator, the brief includes the session status and a
requirements preview. The user file's `autoAdvisor` (`true` = 3, `false` = off, or
`{ "maxPerChat": 0–20 }`; default 3; a project file setting it is rejected) caps consults per
Pi chat, counted by `waicc-advisor-consult` entries on the chat branch, appended before the
run so failed or stopped consults count. One consult runs at a time per chat.

`waicc_suggest_command {commands: [{command, why}] (1–4), question?}` (coordinator only)
offers WAICC commands to the human. Each command must be one line of at most 500 characters
whose first word is `/` plus the name of a command this extension registered; otherwise
the call fails and lists them. Without UI it fails and tells the agent to write the commands
in its reply. With UI it returns at once, listing the offered commands, and keeps the offer
for that chat (a later call in the same turn replaces it). On `agent_end` the offer is shown
in Pi's select dialog with `<command>  ·  <why>` rows and `None of these`; the dialog is not
awaited by the turn, so an unanswered picker never keeps the agent working. On `agent_start`
or `session_shutdown` an open picker is aborted and the offer dropped. On a pick, the
command's registered handler runs at once with the rest of the line as its arguments, through
the same wrapper as a typed command (trust and coordinator checks, errors shown to the
human), with the event's context; no WAICC command uses the command-only context methods.
The input box is not touched. The agent is not told what was picked; the command's output
goes to the human only. Escape or `None of these` runs nothing.

With a UI (the interactive screen or an RPC client) every WAICC command, typed or picked, sets the `waicc-busy` widget
to `⏳ WAICC: running /<name>…` and waits 25 ms, so Pi draws it before the command's
synchronous work (snapshots, session files) starts. The widget is cleared when the command
ends, including on failure. A UI that cannot show widgets runs the command without it.

The tracker is a read-only view outside the project. After each WAICC tool and command,
`agent_end`, `session_start` and each dispatch or consult progress tick, a coordinator chat in
a trusted project schedules (at most once per 2 s, timer unref'd) a summary of its project:
open sessions and the five most recent closed ones (contract title, requirements, tasks with
whether the latest whole-work report claims them, decisions, rounds with outcome, assessment,
findings, checks and the round's last dispatch result), the last ten consults, the chat's
running dispatches and consult, its last five run notices, and needs-you items (open human or
external decisions; READY_TO_CLOSE, PLAN_READY, AWAITING_ASSESSMENT, NEEDS_CLARIFICATION, BLOCKED
and WAITING_FOR_REPLY when nothing runs for that session). Session summaries are cached by
latest journal entry. It is written atomically to
`$PI_CODING_AGENT_DIR/waicc-tracker/projects/<key>.json` (key: digest of the project root),
then every project file updated within 14 days whose root still exists (at most 30) is
written into `data.js` as `window.waiccTracker({...})`, which `index.html`, copied from
`templates/tracker.html`, loads every 3 s and renders with all text escaped.
Each project status carries `extension: {version, build, outdated}`. `build` is the first 12
hex of a SHA-256 over the sorted names and content digests of the package's `src` (nested
folders included; `.ts`, `.js`, `.json`, `.html`) and `templates`, computed when the module
loads. At most once a minute it is recomputed from disk; once it differs, the chat is outdated
for the rest of its life: the status adds a `/reload` needs-you item and, after the next
`agent_end`, a chat with UI is told once to type `/reload` (Pi's reload loads extensions
afresh). `session_shutdown` writes the project with no running work. Failures are ignored. Recipient
chats, dispatched agents (`WAICC_DISPATCH_PIN`), `WAICC_TRACKER=off` and the `off` marker
file that `/waicc-tracker off` creates all skip it.

Each dispatch `result.json` and consult `result.json` records `usage` as the agent reported
it, or null: `{inputTokens (cached included), cachedTokens, outputTokens, costUsd}`. Claude's
final `result` line gives its totals and `total_cost_usd`; Codex's `turn.completed` events
give tokens, summed, with `costUsd: null`; Pi's assistant `message_end` events give tokens
and `cost.total`, summed. Unrecognised output yields null, never a failed run. The tracker
lists every run's usage per project (at most 2,000, closed sessions included) for the page to
total by day, agent, model, step and session, plus per-round and per-session totals. Before
that list is cut, `allTime: {since, byKind: {main, dispatch, advisor}}` totals every recorded
figure (tokens, cached tokens, output, cost, runs, unpriced runs, main-agent messages), so
the page's All figures are exact; a project file without it falls back to its run list.

The main agent is counted per Pi chat. Before each tracker write (also after each assistant
`message_end` and `model_select`), a coordinator chat whose entry count or model changed sums
every assistant message entry on every branch (`usage.input + cacheRead + cacheWrite` as input,
`cacheRead` as cached, `output`, `cost.total`) by `provider/model` and UTC hour, and writes
`$PI_CODING_AGENT_DIR/waicc-tracker/chats/<key>/<chat id>.json`
`{schemaVersion: 1, chatId, name, model (current provider/model or null), updatedAt, hours}`.
The project status reads every chat file of its project (at most 100, newest first), adds each
hour to the run list with `kind: "main"`, `chatId` and `messages`, and lists the ten latest
chats' name and model. Main-agent use never counts toward the budget. The user
file's `budget.perSessionUsd` (above 0, at most 10,000; a project file setting it is
rejected) is checked before an automatic loop cycle and before `--review`'s dispatch. If the
session's reported dispatch dollars reach it, the run ends with a notice; dispatches the
human types are never refused.

The user file's `alerts` (a project file setting it is rejected) takes `quietMinutes`, a
whole number 0–240 (default 10; 0 never), and `desktop`, a boolean (default false). A running
dispatch records when it last emitted a progress event; once `quietMinutes` pass without one,
the chat is told once per quiet spell, the live run carries `lastActivityAt` and
`quietAfterMs`, and the project's needs-you list starts with
`<label>: no new step for <n>+ minutes` (the last step as detail, `/waicc-dispatch --stop`
as command). Nothing is stopped or retried. With `desktop`, after each tracker write the
chat compares the project's needs-you items (by session and text) with
`$PI_CODING_AGENT_DIR/waicc-tracker/alerted/<key>.json`, records the current set there, and
raises one notification for one new item or one summary for several; the first comparison
only records. Windows uses a PowerShell toast with an encoded command and XML-escaped text,
macOS `osascript` with the text as arguments, Linux `notify-send`; none is waited for.

Isolated worktrees link top-level `node_modules`, `.venv` and `venv` directories that Git
ignores (a junction on Windows) instead of copying them. Changes under a linked folder are
dropped from the change list, and removal unlinks each folder (removing only the link)
before `git worktree remove`.

Claude and Codex implementation runs in an isolated Git worktree. Dispatch stages exactly
the fingerprinted files into a temporary index, writes a snapshot commit on no branch
(`commit-tree`, parent HEAD when one exists), adds a detached worktree outside the project
without checkout and copies the checkout's own bytes into it, so line-ending settings
cannot alter the copy; the checkout and its index are untouched. The agent's MCP server is
started with `--implement`, which allows receiving that one implementation request, and
`waicc_read_input` serves the assignment's inputs to an agent outside the project. After
the run, `git add -A` in the worktree and `diff --cached --name-status --no-renames`
against the snapshot list added, modified and deleted files; ignored output is excluded.
Changes are applied under the writer lock only if a reply exists, every path passes the
task allowedPaths check and the checkout fingerprint still equals the snapshot's; the
changed files are then copied (or deleted) and the worktree removed. Otherwise nothing is
applied and the worktree is kept; `result.json` records the changes, outcome and reason. A `dispatch/<id>/start.json` artifact is committed
before launch: agent, model, program, arguments, start time and timeout. An unfinished
start blocks another dispatch until its result is recorded or its timeout plus two
minutes passes. The agent runs at project root with stdin closed and is killed with its
process tree at the timeout or on `--stop`. `result.json` records exit code, kill flag,
whether a reply now exists and bounded stdout/stderr tails; it is not appended to a
CLOSED session. Dispatch never ingests, assesses, adopts, retries or closes.

Adapters: Claude Code (`claude -p`, a per-run pinned MCP config with
`--strict-mcp-config`, WAICC MCP plus Read/Grep/Glob allowed, Edit/Write/NotebookEdit/Bash
disallowed); Codex (`codex exec --sandbox read-only`, a pinned MCP server through `-c`
overrides, only the four recipient tools enabled and approved); Pi (`pi -p` loading this
extension with `WAICC_DISPATCH_PIN=<session>:<request>[:implement]`, which pins recipient
mode at session start, read-only or, with `:implement`, edit/write confined to the task's
allowedPaths with shell still blocked; a refused pin removes all tools and instructs the
run to stop); Antigravity (`agy -p --sandbox`, using the user's own MCP configuration;
experimental). Pin variables only ever narrow permissions.

## Focused advisor replies

An advisor request pins `advisor: {question, requirementIds}` on the round, request
and export manifest. `waicc_request` accepts mode advisor with focus as the question
and optional requirementIds; omit taskId. Issue against the current saved contract,
not via `waicc_prepare`, and finish/cancel an existing pending request first.
Unknown/duplicate requirement IDs are rejected. The contract version is unchanged.

The ordinary reply identity, summary, coverage, findings, questions and checks remain.
Add this advisor-only payload, preserving the exact question from the template:

```json
{
  "advice": {
    "question": "Should pagination use cursors or offsets?",
    "options": [
      {
        "id": "cursor",
        "title": "Cursor pagination",
        "benefits": ["Stable continuation boundary"],
        "tradeoffs": ["Needs a stable unique sort key"],
        "evidence": [
          "AC-001 calls for pagination; source inspection has not established ordering."
        ]
      },
      {
        "id": "offset",
        "title": "Offset pagination",
        "benefits": ["Direct page selection"],
        "tradeoffs": ["Concurrent inserts can shift page boundaries"],
        "evidence": [
          "The original request does not require direct page-number navigation."
        ]
      }
    ],
    "recommendation": {
      "optionId": "cursor",
      "rationale": "Prefer stable continuation, conditional on confirming the ordering key."
    },
    "assumptions": [
      "A stable unique ordering key is available; confirm before implementation."
    ],
    "proposedAmendments": [
      "Specify ordering and pagination behavior in AC-001."
    ]
  }
}
```

This is an illustrative payload, not evidence about the recipient's project.
Option IDs must be unique and the recommendation must reference a supplied option.
With outcome ready, at least two options and a recommendation are required; each
option needs benefits, tradeoffs and evidence. A non-ready reply can have no options
and recommendation null when there is insufficient information. Unknown nested
fields are rejected. Coverage must match the selected scope exactly, including an
empty array for question-only advice. Other contract requirements are context, not
implicitly reviewed or certified.

Advisor handoffs/exports include `memory.json`, captured at issue from relevant,
active memory only: confirmed by the human, or by the opt-in corroboration rule below. Each entry retains its source and digest.
Conversation history carries advice, scope and assessments into subsequent rounds.
Neither memory nor prior replies are independent proof or authorization.

Pattern lessons are memory entries of kind `lesson` with `evidence: [{sessionId, requestId,
findingId}]` and source text `review findings: <n> in <m> sessions`. Their digest covers each
cited finding's ids, description and evidence, so an edited or deleted finding makes the entry
stale. After `waicc_assess`, if the assessed round is a review with findings, the result may
carry `recurringFindings`: this round's non-info, undisputed findings and up to 15 such findings
from other sessions' ASSESSED review rounds. Findings already cited by any lesson are left out,
and the rest are ranked by Jaccard overlap of stemmed significant words. Existing lessons and an
instruction are included. `waicc_learn_pattern {lesson (12–600 chars), findings (2–10)}`,
coordinator only, requires findings from at least two sessions, each an assessed, undisputed
review finding cited once. It refuses any finding already cited by a lesson, whether candidate,
active or revoked, and creates an unconfirmed candidate. Confirmation stays
`/waicc-memory confirm`. `recall` always includes active pattern lessons, ranked first, whatever
the query, so they reach every handoff's memory snapshot. Pending pattern lessons appear in the
tracker's needs-you list. `waicc_learn_pattern {lessonId, findings (1–10)}` instead adds
findings to an existing, unrevoked lesson: at least one must come from a session the lesson
does not rest on yet, none may back any lesson, and the lesson must still be current. Its
source text and digest are then recomputed.

`waicc_memory propose` takes an optional `quote` (12–1200 characters) that must appear in
the source exactly, ignoring line endings and trailing spaces. An entry with a quote is
current while the quote is in the file; without one, while the file's digest is unchanged.
The proposal records `proposedIn {sessionId, model}` from the bound session and the main
agent's model. A later proposal of the same kind about the same file from another session,
with the same text or a Jaccard overlap of at least 0.6 with a current entry, is appended to
that entry's `corroborations` (one per session) instead of creating an entry.
`waicc_memory propose {kind: decision, decisionId}` reads the bound session's current
contract and its decision records: the decision must be resolved and its latest matching
record `recordedBy: human-command`. The entry's text is the question plus the recorded
answer, its `decision {sessionId, decisionId, record}` points at the record artifact, and
its digest covers that record. `/waicc-memory confirm` also sets `confirmedBy: human`.

With `"memory": {"autoApprove": true}` in the user file (rejected in a project file; read
from the user file only, an unreadable one counting as off), `memoryStates` reports a
current candidate as `active` with `approvedBy: waicc-rule` when `judge`
(src/memory-rule.ts) approves it. The verdict is computed on every read, never stored.

- Any kind is blocked by a Jaccard overlap of at least 0.5 with another, revoked entry.
- A decision entry is approved unless blocked.
- A lesson is approved at 3 or more distinct evidence sessions.
- Kinds other than `fact` are otherwise blocked. A fact is blocked without a quote, when its
  source cannot be read or no longer holds the quote, when a code name in its text is
  missing from the source, or when an undisputed, non-info review finding in any session
  overlaps it by at least 0.5. Code names are backticked spans, camelCase and snake_case
  words and path-like words; a path also matches the end of the source path or its file name
  in the source.
- A fact needs 4 points: corroboration from another session +2; at least two distinct models
  among the proposer and those sessions +2; each session whose code `reviewApproval` was
  assessed after the entry was created and whose approved round's `changedPaths` include the
  source +1, at most 2; created at least 7 days ago with the quote still there +1.

`recall(…, includeCandidates)`, the human's `/waicc-memory` list, adds each candidate's
verdict `rule {approved, points, needed, reasons, blocked}`. `auditMemory`
(`/waicc-memory audit`, CLI `waicc memory audit`) judges every entry, revoked and confirmed
ones included, and reports how many human confirmations the rule agrees with, the revoked
entries it would have approved, and the candidates it approves now. With the rule on,
`pendingLessons` leaves out lessons it approves.

## Assessment

The primary Pi agent uses `waicc_assess`; CLI users can supply an assessment JSON:

```json
{
  "requestId": "COPY-THE-ACTUAL-REQUEST-ID",
  "decision": "followup",
  "rationale": "Resolve the missing authorization behavior against the existing middleware.",
  "dispositions": []
}
```

`decision` is ready, planned, noted, followup, needs_changes or blocked. `contract` optionally carries
an explicitly adopted revision, except on a ready review: changed contracts need
a fresh review round. Adopt a reviewer's proposal with followup or needs_changes.
Each disposition is `{findingId,disposition,evidence}`
with disposition resolved, disputed or accepted; evidence is always required, and for
accepted it is the reason the finding is knowingly left unfixed. Only medium/low findings
may be accepted, and never in a code review or delegated whole-work round. On ready or
planned, every non-info finding needs a disposition (code review keeps its stricter rule:
each non-info finding must be disputed, otherwise fixed and reviewed again). Status
`acceptedFindings` lists `{requestId, findingId, severity, description, reason}` for every
accepted finding, and `closure.json`/`CLOSURE.md` repeat them. Dispositions are recorded claims with evidence, not independent
proof. Structural checks do not establish the quality of Pi's judgment.

For advisor, ready, planned and contract are forbidden. Use noted only for a ready advisor
reply with no unresolved questions; this closes the exchange as ADVICE_READY without
adding a round, changing the contract, or resolving findings automatically. Scoped
unverified coverage, remaining risks and not-run checks do not become passes.
This is not a readiness assessment. Followup retains advisor mode and selected IDs,
uses the assessment rationale as the next question and includes the prior discussion.
needs_changes/blocked records the issue without starting contract preparation.
noted is rejected for other modes. Adoption requires a human decision and a separate
explicit contract revision; new requirements still require an amendment.

Planned planning accepts the specification as PLAN_READY without an external implementation handoff.
The main agent then completes all work only with current recorded development
authorization; new planning-only scope stops there until the human transition.
A plan creates no new execution authority. Legacy objective-unrecorded ready planning
can create an implementation handoff; new objective-aware ready planning stays
PLAN_READY. Ready implementation requests independent review. Code-review PASS uses
READY_TO_CLOSE; new specification-only PASS uses SPEC_APPROVED.
A task-scoped ready review still requires full review and cannot authorize closure.
No state means
automatic deployment or verified delivery. The extension never runs model inference
itself: preparation/assessment slash commands submit work to the existing Pi agent,
using its configured provider/model. External handoffs are manual in v0.1.0.
The advisor slash command issues a handoff directly without inference; its reply
is assessed through the existing Pi agent on /waicc-continue.

## Default-on automatic planning (Pi)

Human `/waicc-auto-planning [on|off]` reads/sets a `waicc-auto-planning` custom
entry scoped to the current Pi chat/project branch. Default is on when no preference
exists, including new chats and existing branches; no global or project preference
file is changed. Explicit off remains off. Old complex commands/settings normalize
to on with the broader step-tracking policy; unknown saved modes fail closed as off.
Resume/reload reads the branch preference,
while live input tokens are deliberately not restored. Recipients cannot change
the preference or use the startup tool, even with the default on.

The input hook captures only a fresh idle interactive/RPC input, not queued/steered,
slash, extension-generated or custom input. `[no-plan]` as the leading token skips
startup mechanically. Before-agent-start must match the captured text exactly;
another extension's transformed prompt is not silently treated as the original
request when it changes after capture. Pi exposes the input-hook text, not an
earlier pre-transform original; transformations by earlier handlers are outside
this extension's visibility. Raw attached image bytes are not copied into contract
requirements; the owner must preserve important visual context/references and
access limits before handoff. A run-local UUID is exposed to the main model.
New input, human commands, turn end, reload
or branch navigation invalidates it. In-run context compaction can recover the
active token without starting another turn or forwarding an archive.

`waicc_start_planning {requestId,reason}` requires trust, coordinator role, enabled
mode and that live token. It takes no requirements/approval/authorization argument.
Plan usefulness/work-request classification and natural-language skip requests are the
existing main model's judgment, not a second model call or a runtime classifier
guarantee. Tracked steps, dependencies, separate completion checks or coordinated
changes justify a proportional plan even for small/non-complex work. Trivial one-step
edits and conversational questions need no new contract. Continue an already selected
objective without restarting planning. The hooks themselves never create a contract. The tool captures the
exact input (maximum 64,000 characters), with objective planning and no plan
approval/development grant. `session.autoPlanning` records chatId, requestId and
requirementsDigest; a deterministic origin-derived session ID and the project
writer lock make creation/retry idempotent. Conflicting origin requirements,
partial/corrupt state, closed/deleted origin sessions fail closed. There is no
separate non-atomic origin ledger. This low-level creation helper is not an
authentication API; the Pi entry point enforces the effective preference and role/input checks.

A selected open contract is returned unchanged, never replaced or auto-amended.
Its current scope/phase/pending work controls the next step. Unrelated/ambiguous
requests need an explicit human choice. With no binding, any existing open contract
requires explicit selection or a manual new `/waicc-planning`; closed/deleted/missing
selections stop rather than retarget. Concurrent startup cannot duplicate work.
Manual starts remain intentional separate-session creation.

After successful startup the coordinator saves important prior chat context and
uses waicc_prepare mode planning to freeze a brief; tasks may be []. The planner
investigates source and proposes the detailed contract. Handoff/clipboard, reply
validation, independent owner adoption and human /waicc-develop are unchanged.
Automatic startup launches no agent/process and grants no implementation, tests,
scope changes, memory confirmation, approval or closure. Disabling it changes no
existing canonical contract or pending assignment.

## Review verdict and explicit closure

### Optional work delegation and shared context

Default implementationOwner/testingOwner is main. `/waicc-planning --delegate` saves
the original requirements without the flag and selects implementationOwner delegate.
After planning adoption the coordinator may issue ONE whole-work implementation
request. `/waicc-help-develop [focus]` selects delegation later and issues that request;
`/waicc-test [focus]` similarly selects optional testing. Both require an accepted
current plan, resolved execution gates, no pending round and no task/batch scope.
Subsequent waicc_request implementation/testing requires the corresponding saved
human delegation choice. `/waicc-help-develop --main` / `/waicc-test --main` restores
main ownership without a handoff, after pending work is assessed/cancelled. These
commands never launch agents or kill existing workers. CLI:
`help-develop <session> [--main] [focus]` (`implement` remains its alias),
`test <session> [--main] [focus]`; `start --delegate <requirements>`.

planApproval pins the accepted contract version/requirements/request. Preparing a
new draft or amending requirements clears acceptance. Intentional in-scope contract
adoption during failed code review carries it forward for the all-fixes cycle.
Older sessions recover acceptance read-only from immutable planning assessments and
the exact adopted contract, not merely from a status label.

The owner saves important chat-only context with waicc_context (CLI context <session>
<summary>) before dispatch. It cannot update during pending work and never replaces
requirement amendments or adopts untrusted advice automatically. Each new round
has contextVersion 1 and immutable CONTEXT.md/context.json, requirements.md (all
amendments), complete saved round conversation, confirmed-only memory.json and
relevant skills. Implementation/testing also carry wai-testing. No original chat
is invented or copied implicitly. Old round files are not rewritten.

context.json contains coordinator context, role ownership, plan pins, decisions,
assumptions/risks/questions, dependency/path scope, all historical finding/check
claims with source/version/status labels, and a checkEvidence path/digest index.
Recorded check start/result files are copied unchanged under evidence/. Exports
include the same packet/evidence and portable skills, but no source checkout or
authentication files. Large Pi assignments provide exact input-file paths instead
of dumping oversized history into the prompt; complete evidence remains on disk.

Delegated coding ready requires a full completion report and ordinary scope/check
assessment. Missing/unrun checks yield NEEDS_TESTING; supported implementation/testing
yields NEEDS_REVIEW, never PASS. The coordinator independently inspects actual diff,
completion/acceptance and test evidence before deciding whether it runs missing
tests itself, uses selected optional testing, or creates ONE full code review.
Testing is code/test-source read-only, cannot propose/adopt replacement contracts,
and ready requires executed checks (not just not_run) plus normal readiness rules.
Failed implementation/testing is assessed before ALL fixes; no automatic per-task
or immediate followup review is generated. Only full code review can recommend PASS.

### Evidence and suggested fixes

Every actionable review issue should include concrete evidence and suggestedFix:
source path with line/symbol or actual failing command/test/output, the triggering
case and expected/observed behavior, defect impact and relevant requirement/criterion,
plus a minimal in-scope remedy and regression verification. Static proof is valid;
label inference, unavailable inputs and unrun reproduction rather than inventing them.
Nonempty evidence is enforced; semantic proof and proposed fixes still need independent
owner verification. Suggestions are inert advice, never executable authority.

Normalizer v3 copies suggestion/recommendation/fix/suggested_fix into suggestedFix
when canonical text is missing; text arrays join with newlines. The original alias
remains in extensions, and raw replies/audit remain immutable. Canonical suggestedFix
takes precedence; nothing synthesizes missing evidence or a remedy. Old replies
without a suggested fix remain readable. Status lists missingFixSuggestions so the
owner can investigate a remedy without another handoff solely to repair wording.
Existing frozen rounds are never re-normalized or silently upgraded.
The same check aliases/outcomes/evidence-array rules apply to completion.checks;
task/finding evidence arrays become text and finding-disposition casing is canonicalized.
Comparison uses explicit description/outcome/evidence claims, not inert extensions,
so a failed or not-run result cannot be hidden by conflicting completion metadata.

### Whole-work code review (default in Pi)

`/waicc-review` prompts the main agent to finish ALL authorized planned work/fixes
and checks before issuing ONE whole-change review. It never issues a per-task or
batch code review. `/waicc-review --contract` explicitly retains specification-only
review. New Pi `waicc_prepare`/`waicc_request` mode review defaults to reviewKind code;
reviewKind contract is explicit. Old on-disk rounds without review metadata remain
contract-only; they are not upgraded to code approval.

For code review, pass `completion`:

```json
{
  "summary": "All planned implementation and fixes complete; ready for independent review",
  "tasks": [{"taskId": "SEARCH", "evidence": "src/search.ts implements AC-001; cite actual checks"}],
  "checks": [{"description": "Search regression tests", "outcome": "passed", "evidence": "Command and actual result"}],
  "findings": []
}
```

Every contract task appears exactly once with implementation/acceptance evidence.
All execution decisions must be resolved; every check has description/outcome/evidence,
at least one check record is required, and failed checks prevent handoff. Unavailable
checks may remain not_run with honest limits; this does not satisfy required verification.
`findings` contains every actionable finding (all severities except info) from ALL
previous assessed code-review rounds, exactly once by `{requestId,findingId,disposition,
evidence}`. Disposition is resolved or disputed. First review uses []. These are
coordinator claims for independent verification, not task-completion certification.

The round's `review` stores kind code, original baseline source snapshot, complete
changedPaths and completion. `code-review.json` freezes that context for recipients
and export; conversation.json retains ALL prior code reviews, not just three rounds.
The original baseline remains unchanged across fix cycles and contract revisions.
The inventory contains file hashes, not old file contents: reviewers inspect available
Git/SVN diffs/history, untracked/current files and report missing baseline access.
For standalone review, the session may start after changes already exist; its inventory
alone cannot recover earlier changes. Review the available VCS diff and full scope too.

`/waicc-review --rev <range> [focus]` names that change. Git accepts one commit (compared
with its first parent, or the empty tree for a root commit), `a..b`, or `a...b` (from their
merge base to `b`); each side must match `^[A-Za-z0-9_][A-Za-z0-9._/~^@{}+-]*$` and resolve with
`git rev-parse --verify --end-of-options <name>^{commit}`. SVN accepts `rN` or `rN:rM`
(N ≥ 1, M ≥ N), meaning the changes made in revisions N through M (`-r N-1:M`). The range is
resolved and its changes computed before any session is created; an unknown or empty range
creates none. The new session (objective review, requirement
`Review the code change <label>[: focus]`) stores
`revisionReview: {vcs, range, from, to, label}`, and the main agent is asked to prepare a code
review (`waicc_prepare` mode review, reviewKind code) without editing or judging the change.
Every code-review round in such a session runs, with `cwd` the project root,
`git diff --no-color --no-ext-diff --no-textconv --relative -M <from> <to>` and its
`--name-only` list (or `svn diff -r F:T` and `--summarize`) plus the commit log, and writes
`changes.patch` (cut at 400,000 characters with a closing note) and `commits.txt` into the
round. `review.revision` records the range, its `changedPaths`, `truncated`, `patchBytes` and
the checkout's revision; `review.changedPaths` is the union of the range's paths and the usual
baseline comparison, so re-reviews also cover fixes. The handoff names both files and says when
the checkout is not at the range's end. Exports include both files.

`/waicc-review --mr <n> [--remote r] [--into b] [focus]` takes `n`, `!n` or `#n`. The remote is
`--remote`, the only remote, or `origin`; a GitHub URL means `refs/pull/<n>/head`, anything else
`refs/merge-requests/<n>/head`. The target is `--into` (a branch name matching
`^[A-Za-z0-9_][A-Za-z0-9._/-]*$`), else `refs/remotes/<remote>/HEAD`, else `git ls-remote --symref
<remote> HEAD`. `git fetch --no-tags --quiet --end-of-options <remote> +<mr ref>:refs/waicc/mr/<n>/head
+refs/heads/<target>:refs/waicc/mr/<n>/target` runs asynchronously with `GIT_TERMINAL_PROMPT=0`
and `GCM_INTERACTIVE=never`; the range is `merge-base(target, head)..head`, labelled
`merge request !n into <target>`. `revisionReview.mergeRequest` records
`{remote, number, provider, target, url, head}`, the URL without any user name or password.
In a chat whose selected open session is the same remote and number, the command refreshes
`revisionReview` (no pending round allowed) instead of creating a session. For any revision
review whose patch exceeds 100,000 characters across several folders, the changed paths are
grouped at the first depth (1–4) where they split, and up to 30 groups get
`changes/<folder>.patch` (pathspec `:(literal)<folder>/`, each cut at 400,000 characters),
listed in `review.revision.parts`. Revision-review handoffs ask for `path:line` at the start of
each finding's evidence.

`/waicc-review --mr --list [--remote r]` (or `--mr list`) picks the remote as above. With a
GitLab host token it reads `GET …/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=50`;
otherwise `git ls-remote --end-of-options <remote> refs/merge-requests/*/head` (`refs/pull/*/head`
on GitHub), newest 30 numbers. Each row is marked when a session in this project has
`revisionReview.mergeRequest` with that remote and number. With UI, a `select` choice continues as
`--mr <number> [--remote r]`; without it, the list is shown as a message.

The user file's `gitlab` (a project file setting it is rejected) maps at most 10 hosts
(`^[A-Za-z0-9.-]+(:\d{1,5})?$`, case-insensitive) to `{token? | tokenEnv?, allowHttp?}`. The API
origin and project path come from the recorded remote URL (https, http, `git@host:path` or
`ssh://`, whose port is ignored); a token is sent only to a listed host, only as the
`PRIVATE-TOKEN` header, never over http unless `allowHttp`, with the system and bundled CA
certificates trusted. When the host has a token, `--mr` reads `GET /projects/:path/merge_requests/:n`
and gives the main agent its title and description as data. `/waicc-mr-comments` is a human
command that requires Pi's UI. It takes the session's last ASSESSED code-review round, reads the
merge request, and refuses unless `diff_refs.head_sha` equals the reviewed head and its state is
`opened`. Candidates are the reply's findings that are not disputed and not `info`; a finding is
placed on a line when its evidence starts with `path:line` for a path in
`revision.changedPaths` (prefixed with `git rev-parse --show-prefix`). Each line comment's body
starts with `automatedNotice` (a quoted "Automated review by AI agents… may be a false alarm"
line); the summary note is titled `### 🤖 Automated WAICC review …`, states the same once, and
omits the notice from the findings it lists. Each candidate's key is its
location and normalized description; keys already in the session's `mr-comments/*.json` are not
offered again. After a `select` (all, one by one with `confirm`, summary only, cancel) and a final
`confirm`, line findings are posted with `POST …/discussions` and a text position
(`base_sha`, `start_sha`, `head_sha`, `new_path`, `new_line`); an HTTP 400 moves that finding into
the summary, any other failure stops. One `POST …/notes` summary follows, listing the outcome,
counts, set-aside findings and the remaining findings by severity. Whatever was posted is recorded
in `mr-comments/<time>-<id>.json` (`requestId`, `headSha`, `webUrl`, each finding's id, key,
`inline` and note id, and the summary note id), even when a later post failed.

The reviewer checks the entire implementation, requirements/acceptance, integration,
regressions, check evidence and all prior fixes, returning one consolidated reply.
Main-agent assessment precedes source edits so the original review remains assessable.
Code-review followup is rejected: use needs_changes/blocked, finish ALL fixes/checks,
then request a fresh full review with a new completion report. Evidence-backed false
positives may be disputed; other actionable findings require fixes and a fresh review,
even if severity is low/medium. Source/version changes invalidate pending/pass review.
No automatic handoffs per finding, external processes or closure are introduced.

Code review ready requires execution-ready contract, addressed implementation coverage,
no questions/failed checks, ready reply outcome and no actionable findings except
explicit evidence-backed disputes. Required evidence that cannot be established is
a blocker. reviewApproval.kind is code or contract; missing legacy kind means contract.
The existing contractReview field remains the verdict for that pinned review kind,
not a universal delivery-verified flag. PASS is never automatic certification.

CLI equivalents: `request <session> review --completion <report.json> [focus]`, or
`prepare <session> <contract.json> review --completion <report.json> [focus]`.
Use `--contract` instead of `--completion <report.json>` for specification-only review.
The exported low-level TypeScript API retains contract-only defaults for legacy callers;
pass `{kind:"code",completion}` as the final prepare/issue option for code review.

`/waicc-cancel [session-id] [reason]` cancels the most recent pending
WAITING/RECEIVED round. A UUID explicitly targets that session without changing
the chat's coordinator selection; without a UUID it uses the selected session.
The reason is optional (default `Cancelled by user.`); legacy reason-only input
is still supported. CLI syntax is `cancel <session> [reason]`. Cancellation records
CANCELLED on the round, NEEDS_CHANGES on the session and clears review approval,
while retaining contract and conversation history. It is not contract closure,
context cloning or external-process termination. Missing pending work makes no
session change. Trust and recipient/coordinator guards remain unchanged.

`contractReview` is separate from session `status`. Values are NOT_REVIEWED,
PENDING, PASS, NEEDS_CHANGES, BLOCKED or STALE. Issuing a new request clears any
previous approval; review sets PENDING. Amendments and revisions invalidate PASS.
A ready full review pins `reviewApproval` with kind (code/contract), requestId,
contractVersion, requirementsDigest, sourceFingerprint and assessedAt. These describe
assessed review evidence of that kind, not independent proof that tests passed.

Normal `/waicc-close [session-id] <reason>` (CLI: `close <session> <reason>`) requires READY_TO_CLOSE
(or SPEC_APPROVED for planning-only/non-development work),
no pending WAITING/RECEIVED round, and that pinned approval still matches the latest
contract, requirements and actual source. The contract and committed review evidence
are checked for modification. It records CLOSED, keeps contractReview PASS, and
saves a closure UUID, closedAt, reason and the approval pins. No model assessment
or responding reviewer can automatically close a session. Close/reopen are not
registered as agent tools; guidance reserves their explicit commands for the user.
This is not authentication or a sandbox against agents with shell/file access.

`/waicc-close [session-id] --force [reason]` (CLI: `close <session> --force [reason]`)
or the shortcut `/waicc-force-close [session-id] [reason]` is a separate human
termination path. It accepts any open lifecycle state, including
a draft without a contract, pending reply, failed assessment or stale approval.
It cancels WAITING/RECEIVED rounds, clears current review approval, records
NOT_REVIEWED and CLOSED, and retains all previous requirements, contracts, replies,
assessments and journal entries. The default reason is `Force-closed by user.`.
It never fabricates review PASS, contract acceptance or delivery verification.
It does not read/trust modified evidence to approve it, nor stop external processes.
The closure has `kind: forced`, `cancelledRequestIds` and no `approval`;
normal closures have `kind: reviewed` plus the pinned approval. Older closures
without `kind` retain their existing reviewed meaning. Repeating force-close on
any already closed session makes no change, including to a reviewed PASS.

An explicit close UUID targets only that project session without rebinding the
chat. Without a UUID the selected session is required; no newest-session guess.
Force-close is permitted as a human stop command in recipient chats, but leaves
their role/tool restrictions intact and invalidates the pinned assignment.
Normal close and cancellation retain coordinator guards. All forms require project
trust, and neither close path is exposed as an agent tool. Force-closed sessions
use the same explicit reopening path and require fresh review before acceptance.

Closure artifacts live at `lifecycle/<closure-id>/closure.json` and `CLOSURE.md`.
Closed sessions stay readable; contract preparation, requests, assessment, amendments,
cancellation, exports and round-limit mutation are blocked until explicit reopening.
Intake of a closed session is a no-op. External code changes after closure do not
rewrite that historical closure or imply verified delivery.

`/waicc-reopen <reason>` (CLI: `reopen <session> <reason>`) records `reopen.json` under
that lifecycle directory, removes the active closure/approval, and sets NEEDS_REVIEW
and NOT_REVIEWED. Old artifacts and journal entries remain unchanged. A new full
review is required before closing again, even when no contract text has changed.

Status exposes contractReview, reviewApproval, closure and deliveryVerified.
Lists include contractReview and deliveryVerified alongside activity timestamps.
Before closure, a changed source projects READY_TO_CLOSE/PASS as STALE on status
reads without a state write; close also rechecks freshness under the writer lock.
Both deliveryVerified and legacy verified remain false throughout. Legacy sessions
without these fields default to NOT_REVIEWED and deliveryVerified false; they do
not inherit an approval from an old READY_FOR_HANDOFF record.

## Session lists and recoverable deletion

`/waicc-list` lists open sessions, independently of the selected session. `all`
includes retained CLOSED sessions; `closed` shows only those sessions. Default
unselected `/waicc-status` and CLI `status` also hide CLOSED; explicit
`/waicc-status all` remains an all-retained-session view. A selected session or
explicit ID can still be inspected when CLOSED. Listing does not mutate state,
change bindings or perform model inference. Ordering and timestamps are unchanged.

`/waicc-delete <session-id>` (CLI: `delete <session>`) requires an explicit ID,
project trust, coordinator mode and a CLOSED journal state. Under the project
writer lock it validates both complete paths and atomically renames exactly
`sessions/<id>` to `deleted-sessions/<id>` within `.pi/pi-waicc`. It never recursively
erases data, follows junctions, overwrites another copy or deletes source, shared
memory or other sessions. The complete original journal/artifact tree remains
unchanged. An already-deleted session is an idempotent no-op after validating its
stored identity and CLOSED state. Open sessions must be closed explicitly first.

Deleted sessions are excluded even from `all`. `/waicc-list deleted` (also
`/waicc-status deleted`, CLI: `list deleted`) reads only recovery storage.
`/waicc-restore <session-id>` (CLI: `restore <session>`) uses the same trust/role/lock
and path protections, requires a deleted CLOSED session and no existing destination,
and moves it back with identical history, verdict, closure and activity timestamps.
It does not reopen, select, approve, resume or regenerate a handoff. No purge or
OS recycle-bin integration is provided; deleted data still occupies disk space.

Both mutations are human commands, never agent tools or permissions for agents to
move files themselves. Deleting the current coordinator selection persists a null
session binding without selecting another. Other chats keep their original binding
and report an unavailable/STOP context until the user chooses a session or restores
it; recipient role/tool restrictions remain intact. Restoration does not silently
rebind a cleared chat. The session directory's presence in one store or the other
is the commit point for these moves; no canonical journal entry is rewritten.

## Project roots and sub-projects

The project root is the nearest folder, walking up from the working directory, that has
WAICC state (`.pi/pi-waicc/`), a `.git` or a `.svn`. `/waicc-init` (CLI `waicc init`) creates
that state folder, with its self-ignoring `.gitignore`, in the current folder, making it a
sub-project of a larger repository. A sub-project inside a Git work tree (no `.git` of its
own) is fingerprinted with Git from that folder: `ls-files` and the index listing cover only
its subtree, and the revision is the subtree's own tree (`HEAD:<prefix>`), not the
repository's commit, so commits elsewhere do not change its fingerprint. Git is consulted
only when a parent folder has a `.git`. A Git project of more than 10,000 fingerprinted paths
(at most 100,000) records each file as `git:<blob id>`: from `ls-files --stage` when the file
is tracked and not listed by `diff-files --name-only --relative`, otherwise (changed, staged or
untracked) from `git hash-object --stdin-paths`, which applies the same filters a commit would;
a tracked path `diff-files` lists that no longer exists is `DELETED`. Only those hashed files
count toward the 128 MB limit; links and submodules (index modes other than `100…`) are
refused as before. Projects up to 10,000 paths keep a SHA-256 of each file's bytes. Within one
process the digest is reused while the file's size, `mtimeMs`, `ctimeMs`, `ino` and `dev` are
unchanged; a file whose modified or change time is within 2 s of the snapshot's start is
always read (Git's "racy" rule). Each folder is checked for links once per snapshot, and each
file by its own `lstat`. The values are the same as reading every file. Isolated worktrees of a sub-project start from the
repository's last commit with the sub-project's entries replaced by its fingerprinted files;
the rest is checked out as context, the sub-project's files are copied byte for byte, and the
agent works in the sub-project's folder inside the worktree. Changes are listed relative to
the sub-project; any outside it are relative paths starting `../`, which fail the scope
check, so nothing is applied.

## Persistence and concurrency

Every mutation takes an exclusive project writer lock. New artifacts are written
before an immutable journal entry is atomically published. The last committed entry
is authoritative; orphaned files and interrupted cache writes do not advance state.
Each request can be received and assessed once. A later attempt gets a new request
ID. Source changes, cancellations, amendments and assessments remain in history.
These are local consistency controls, not a sandbox against the same user account.

Each journal entry (and `session.json`) stores every source snapshot in the session (any
object with `vcs`, `fingerprint` and a `files` map: each round's `source`, a code review's
`base`) with `files` replaced by `filesRef`, the SHA-256 of the map's compact JSON, which is
written once to `snapshots/<filesRef>.json` before the entry. Loading puts each map back,
refusing one whose content no longer matches its digest; verified maps are kept in memory
by digest (at most 48). Entries written earlier, with maps inline, still load (up to
256 MB); the next commit stores them by reference. Without this, a large project's session
grew by both snapshots on every code review round, in every later entry.

The artifacts that carry a snapshot are written the same way: `contracts/vNNN/contract.json`
(`source`), each round's `request.json` (`source`, and a code review's `base`),
`code-review.json` (`base`) and `observed-source.json`. Reading a contract for the workflow
puts its map back (a first code review's baseline is the contract's snapshot); the others
are only read for other fields. So recipients, which are pointed at `request.json` and
`contract.json`, never page through file hashes. The recipient assignment's `codeReview`
and an export's `contract.json` drop snapshot maps entirely, including from handoffs
written earlier with maps inline. A code review's baseline is its revision and fingerprint;
`changedPaths` lists what changed.

Session `createdAt` is fixed at creation. `updatedAt` matches the latest committed
journal entry's UTC `at` timestamp and advances only on a session mutation. Reads,
no-op intake and file modification times do not change it. Older session snapshots
without the field recover it from the journal in memory; reading does not rewrite
history or caches. Both timestamps are exposed by status; session lists sort newest
`updatedAt` first, breaking exact ties by session ID.

Contracts capture task dependencies and shared API/data decisions. Execution order
and actual dependency completion are included in the implementation handoff and
assessed in replies; automated parallel scheduling is not implemented.
