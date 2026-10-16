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
  `sourceFingerprint`, `mode`: pinned request identity.
- `outcome`: `ready`, `needs_changes`, `needs_clarification`, or `blocked`.
- `summary`: the actual result.
- `coverage`: exactly one `{requirementId,status,evidence}` row per requirement.
  Status is `addressed`, `missing`, or `unverified`.
- `findings`: `{id,severity,description,evidence}`. Severity is critical, high,
  medium, low, or info. IDs are unique within the reply.
- `questions`: unresolved questions, or `[]`.
- `checks`: `{description,outcome,evidence}`. Outcome is passed, failed or not_run.
  Do not describe a planned check as passed.
- `proposedContract`: optional complete contract body, offered for explicit adoption.

Replies to another request/version are rejected. Matching planning/review replies
whose source changed are archived as stale. An implementation may change source;
its observed post-implementation source is pinned at intake. Any subsequent source
change invalidates assessment. Repeated intake cannot replace an already frozen reply.
After fixing stale inputs, issue a fresh request with a new ID.

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

`decision` is ready, followup, needs_changes or blocked. `contract` optionally carries
an explicitly adopted revision. Each disposition is `{findingId,disposition,evidence}`
with disposition resolved or disputed. High/critical findings require dispositions
before readiness. Dispositions are recorded claims with evidence, not independent
proof. Structural checks do not establish the quality of Pi's judgment.

Ready planning creates an implementation handoff; ready implementation requests
independent review; ready review leaves a handoff-ready artifact. No state means
automatic deployment or verified delivery. The extension never runs model inference
itself: slash commands submit preparation/assessment work to the existing Pi agent,
using its configured provider/model. External handoffs are manual in v0.1.0.

## Persistence and concurrency

Every mutation takes an exclusive project writer lock. New artifacts are written
before an immutable journal entry is atomically published. The last committed entry
is authoritative; orphaned files and interrupted cache writes do not advance state.
Each request can be received and assessed once. A later attempt gets a new request
ID. Source changes, cancellations, amendments and assessments remain in history.
These are local consistency controls, not a sandbox against the same user account.

Contracts capture task dependencies and shared API/data decisions. Execution order
and actual dependency completion are included in the implementation handoff and
assessed in replies; automated parallel scheduling is not implemented.
