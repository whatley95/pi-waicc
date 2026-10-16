# WAICC protocol v1

The authoritative contract is JSON. Its Markdown is generated from the same data.
Requests/replies use schemaVersion 1. Unknown reply/contract fields are rejected.
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

## External reply

Start from the generated `reply.example.json`; its identity values are real and
must remain unchanged. Save the completed object as `reply.json`, not a fenced block.

- `schemaVersion`, `sessionId`, `requestId`, `contractVersion`, `requirementsDigest`,
  `sourceFingerprint`, `mode`: pinned request identity. Modes are planning, review,
  implementation and advisor.
- `outcome`: `ready`, `needs_changes`, `needs_clarification`, or `blocked`.
- `summary`: the actual result.
- `coverage`: exactly one `{requirementId,status,evidence}` row per requirement.
  For advisor, only the explicitly selected IDs are covered (default `[]`).
  Status is `addressed`, `missing`, or `unverified`.
- `findings`: `{id,severity,description,evidence}`. Severity is critical, high,
  medium, low, or info. IDs are unique within the reply.
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

`decision` is ready, noted, followup, needs_changes or blocked. `contract` optionally carries
an explicitly adopted revision, except on a ready review: changed contracts need
a fresh review round. Adopt a reviewer's proposal with followup or needs_changes.
Each disposition is `{findingId,disposition,evidence}`
with disposition resolved or disputed. High/critical findings require dispositions
before readiness. Dispositions are recorded claims with evidence, not independent
proof. Structural checks do not establish the quality of Pi's judgment.

For advisor, ready and contract are forbidden. Use noted only for a ready advisor
reply with no unresolved questions; this closes the exchange as ADVICE_READY without
adding a round, changing the contract, or resolving findings automatically. Scoped
unverified coverage, remaining risks and not-run checks do not become passes.
This is not a readiness assessment. Followup retains advisor mode and selected IDs,
uses the assessment rationale as the next question and includes the prior discussion.
needs_changes/blocked records the issue without starting contract preparation.
noted is rejected for other modes. Adoption requires a human decision and a separate
explicit contract revision; new requirements still require an amendment.

Ready planning creates an implementation handoff; ready implementation requests
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
