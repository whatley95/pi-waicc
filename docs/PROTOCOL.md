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

Planned planning accepts the specification as PLAN_READY without an external implementation handoff.
The main agent then completes all work if the original assignment authorizes implementation;
planning-only scope stops there. A plan creates no new execution authority.
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

### Optional work delegation and shared context

Default implementationOwner/testingOwner is main. `/waicc-planning --delegate` saves
the original requirements without the flag and selects implementationOwner delegate.
After planning adoption the coordinator may issue ONE whole-work implementation
request. `/waicc-implement [focus]` selects delegation later and issues that request;
`/waicc-test [focus]` similarly selects optional testing. Both require an accepted
current plan, resolved execution gates, no pending round and no task/batch scope.
Subsequent waicc_request implementation/testing requires the corresponding saved
human delegation choice. `/waicc-implement --main` / `/waicc-test --main` restores
main ownership without a handoff, after pending work is assessed/cancelled. These
commands never launch agents or kill existing workers. CLI: implement/test <session>
[--main] [focus]; start --delegate <requirements>.

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

Normal `/waicc-close [session-id] <reason>` (CLI: `close <session> <reason>`) requires READY_TO_CLOSE,
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
