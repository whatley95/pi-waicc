# WAICC protocol v1

The authoritative contract is JSON. Its Markdown is generated from the same data.
Requests/replies use schemaVersion 1. Unknown reply/contract fields are rejected,
except finding annotations preserved by the compatibility layer described below.
The extension controls generated IDs, paths, input fingerprints and journal writes.
Agent output is data, never a shell command or permission to change scope.

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
Review ready and explicit closure can accept a complete specification with documented
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
`/waicc-handoff [session-id]` renders a clearly delimited copy-only prompt followed
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
  implementation and advisor.
- `outcome`: `ready`, `planned` (planning only), `needs_changes`, `needs_clarification`, or `blocked`.
- `summary`: the actual result.
- `coverage`: exactly one `{requirementId,status,evidence}` row per requirement.
  For advisor, only the explicitly selected IDs are covered (default `[]`).
  Status is `addressed`, `missing`, or `unverified`.
- `findings`: `{id,severity,description,evidence,extensions?}`. Severity is critical,
  high, medium, low, or info. IDs are unique within the reply. `extensions` optionally
  holds untrusted annotation fields; it does not change scope or workflow decisions.
- `questions`: unresolved questions, or `[]`.
- `checks`: `{description,outcome,evidence}`. Outcome is passed, failed or not_run.
  Do not describe a planned check as passed.
- `proposedContract`: optional complete contract body, offered for explicit adoption;
  forbidden for advisor replies, which suggest amendments as text instead.
- `advice`: required only for advisor replies; see below. Rejected in other modes.

Replies to another request/version are rejected. Matching planning/review/advisor replies
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
This does not manufacture evidence, repair identity, change coverage/check outcomes,
relax proposed-contract validation, execute annotations or accept a proposed change.
The canonical validator remains strict after this transport conversion. Prefer the
canonical format in new replies; this is compatibility, not arbitrary free-form intake.

At coordinator intake, `received.json` retains the original reply bytes and
replyDigest still hashes those bytes. The journal's round.reply is the normalized
canonical view. When conversion occurred, `received.normalized.json` and
`reply-normalization.json` are committed alongside it; the latter records normalizer
version and conversions. Status and subsequent conversation expose replyNormalization
and canonical finding IDs for assessment/dispositions. Repeated intake never
rewrites an already frozen reply, generated IDs or its conversion history. Legacy
received rounds are not re-normalized. Normalized review artifacts are also checked
for modification before closure.

`waicc_reply` validates the same conversion before writing, reports conversions in
its result, and preserves supplied finding fields in the submitted reply.json.
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

`/waicc-receive <session-id> [--implement]` is a human command in a manually opened,
idle, trusted Pi chat in the same project checkout. It requires exactly one WAITING
round with no reply file, and source matching that request. It does not create a
WAICC session/round or mutate its journal, status or updatedAt. Pi's current model
receives the assignment; no model switch, subprocess or scheduler is involved.

The Pi chat persists role recipient plus a pin of sessionId, requestId,
contractVersion, requirementsDigest, sourceFingerprint and mode. Resume restores
that pin and recipient tool profile. Assignment recovery reads the exact committed
contract version, handoff, template and conversation, selected skill paths, and
relevant current confirmed memory. It never chooses a replacement/newer request.
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
No execution-tool exception is made for tests; unavailable checks are not_run.
This is a Pi extension boundary, not an OS sandbox against user actions, trusted
extensions or external programs. External recipients retain their own permissions.

`/waicc-use <session-id>` deliberately leaves recipient mode for coordinator mode
and restores the previous active tool selection. It is a human role change, not a
model tool. Old role-less Pi binding entries remain coordinator-compatible.
Receiving is not a lease: multiple chats can investigate the same request, but only
the first reply file can be submitted. Choose one worker per request manually.

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
active human-confirmed memory only. Each entry retains its source and digest.
Conversation history carries advice, scope and assessments into subsequent rounds.
Neither memory nor prior replies are independent proof or authorization.

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
with disposition resolved or disputed. High/critical findings require dispositions
before readiness. Dispositions are recorded claims with evidence, not independent
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

Planned planning accepts the specification as PLAN_READY without implementation.
Legacy ready planning creates an implementation handoff; ready implementation requests
independent review; ready full-contract review records PASS and READY_TO_CLOSE.
A task-scoped ready review still requires full review and cannot authorize closure.
No state means
automatic deployment or verified delivery. The extension never runs model inference
itself: preparation/assessment slash commands submit work to the existing Pi agent,
using its configured provider/model. External handoffs are manual in v0.1.0.
The advisor slash command issues a handoff directly without inference; its reply
is assessed through the existing Pi agent on /waicc-continue.

## Review verdict and explicit closure

`contractReview` is separate from session `status`. Values are NOT_REVIEWED,
PENDING, PASS, NEEDS_CHANGES, BLOCKED or STALE. Issuing a new request clears any
previous approval; review sets PENDING. Amendments and revisions invalidate PASS.
A ready full review pins `reviewApproval` with requestId, contractVersion,
requirementsDigest, sourceFingerprint and assessedAt. These describe a reviewed
specification and evidence, not proof that code was implemented or tests passed.

`/waicc-close <reason>` (CLI: `close <session> <reason>`) requires READY_TO_CLOSE,
no pending WAITING/RECEIVED round, and that pinned approval still matches the latest
contract, requirements and actual source. The contract and committed review evidence
are checked for modification. It records CLOSED, keeps contractReview PASS, and
saves a closure UUID, closedAt, reason and the approval pins. No model assessment
or responding reviewer can automatically close a session. Close/reopen are not
registered as agent tools; guidance reserves their explicit commands for the user.
This is not authentication or a sandbox against agents with shell/file access.

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

## Persistence and concurrency

Every mutation takes an exclusive project writer lock. New artifacts are written
before an immutable journal entry is atomically published. The last committed entry
is authoritative; orphaned files and interrupted cache writes do not advance state.
Each request can be received and assessed once. A later attempt gets a new request
ID. Source changes, cancellations, amendments and assessments remain in history.
These are local consistency controls, not a sandbox against the same user account.

Session `createdAt` is fixed at creation. `updatedAt` matches the latest committed
journal entry's UTC `at` timestamp and advances only on a session mutation. Reads,
no-op intake and file modification times do not change it. Older session snapshots
without the field recover it from the journal in memory; reading does not rewrite
history or caches. Both timestamps are exposed by status; session lists sort newest
`updatedAt` first, breaking exact ties by session ID.

Contracts capture task dependencies and shared API/data decisions. Execution order
and actual dependency completion are included in the implementation handoff and
assessed in replies; automated parallel scheduling is not implemented.
