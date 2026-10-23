# WAICC — Whatley AI Communication Contract

_Clear contracts. Connected agents._

`pi-waicc` is a Pi extension that turns a development request into versioned
contracts, agent handoff prompts, and a durable conversation inside your project.
It is designed for complicated work that needs explicit requirements, task
dependencies, focused design advice, independent planning or review, and continuity across agents.

The contract defines the job. The handoff prompt tells an agent how to perform it
and where to reply. Pi validates that reply, assesses the evidence, and prepares
the next decision or handoff. A fresh agent can pick up the assignment without
needing the original chat history.

## Quick start

**New here? Read [docs/QUICKSTART.md](docs/QUICKSTART.md)**: install to a closed contract in
ten commands, with one worked example. In short:

```text
pi install git:github.com/whatley95/pi-waicc      # once, in a terminal
/waicc-dispatch --init-profiles                   # once: pick an agent per role
/waicc-planning <what you want, and constraints>  # start a contract
/waicc-dispatch                                   # an agent plans; then /waicc-continue
/waicc-develop                                    # the main agent builds the accepted plan
/waicc-review <focus>                             # then /waicc-dispatch and /waicc-continue
/waicc-close <reason>                             # when the review passes
```

Or `/waicc-dispatch --auto` after `/waicc-planning` to plan, build and review on its own.
`/waicc-tracker` shows every project on one page.

**This README is the full reference.** Contents: [Install](#install) ·
[Start a conversation](#start-a-conversation) ·
[Coding and testing handoffs](#optional-coding-and-testing-handoffs) ·
[Manual handoff](#manual-handoff-exactly-what-to-give) ·
[Dispatch to a headless agent](#dispatch-to-a-headless-agent) ·
[Agent profiles](#agent-profiles-choose-an-agent-per-role-once) ·
[MCP server](#mcp-server-for-any-agent) · [Commands](#commands) ·
[Finish a contract](#finish-a-contract-discussion) ·
[Advisor](#when-the-main-agent-is-stuck-it-asks-the-advisor) ·
[Monorepos](#monorepos-one-service-as-its-own-project) ·
[Storage](#project-storage-and-version-control) · [Memory](#memory-and-wai-skills) ·
[Integrity and limits](#integrity-and-limits). Exact formats and rules:
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Install

Requires **Node.js 22.19+** and the **`@earendil-works` Pi coding-agent host**.
Developed and tested on native Windows with Pi 1.2.0; other platforms have not yet
been verified.

```sh
pi install git:github.com/whatley95/pi-waicc
```

Restart Pi or use `/reload`, then open your target project and resolve Pi's project
trust prompt before using WAICC. The package exposes the extension and all 15
skills: the 14 WAI skills plus the WAICC workflow skill.

To install for one project, run this from that project:

```sh
pi install --local git:github.com/whatley95/pi-waicc
```

For local development, use an absolute path to your clone:

```sh
pi install /absolute/path/to/pi-waicc
```

To update an existing Git install to the latest version, then `/reload` (or restart) Pi:

```sh
pi update git:github.com/whatley95/pi-waicc
```

Pi keeps its own copy of the package (see `pi list`); new commands such as
`/waicc-dispatch` appear only after that copy is updated. **A running Pi keeps the code it
loaded at start:** after `pi update`, run `/reload` in each open Pi chat (or restart Pi),
otherwise you keep seeing the old behaviour and messages. An open chat notices when the
files on disk changed: after its next turn it says once "pi-waicc was updated since this chat
loaded it. Type /reload to use the new version.", and the tracker shows that project's card
as **updated · type /reload**, with `/reload` under Needs you.

WAICC is independent of pi-yoowai. If both packages are enabled, select one copy
of each shared WAI skill in Pi's resource configuration to avoid duplicate names.

## Start a conversation

In Pi, describe the actual outcome and constraints:

```text
/waicc-planning Add customer search with pagination and account isolation. Preserve the existing response format and support the current frontend.
```

Pi saves your exact request and relevant context as a requirements/constraints brief.
The recipient investigates actual source, tests/docs/history and available reference
projects, resolves technical facts and returns the detailed proposed contract/plan.
The owner verifies material claims and consolidates genuine human/external choices
instead of relaying a questionnaire.

1. **Send the planning handoff.** Give the generated `STARTER.txt` prompt to your
   chosen agent with access to the project. It reads `HANDOFF.md`, the contract,
   relevant skills and prior conversation, then writes the designated `reply.json`.
   Or let Pi run it headless: `/waicc-dispatch --via claude --model opus` (see
   [Dispatch to a headless agent](#dispatch-to-a-headless-agent)).
2. **Continue in Pi.** Run `/waicc-continue`. WAICC validates the request identity,
   contract version, requirements digest and source state. Pi then assesses the
   reply against the original requirements and actual evidence.
3. **Accept the plan.** The owner intentionally adopts supported
   corrections with `waicc_assess.contract` and uses decision `planned` for a complete
   plan. This records `PLAN_READY` without an external implementation handoff. Proposals
   are never adopted automatically.
4. **Keep genuine decisions visible.** Future human/external choices carry evidence,
   a recommendation and affected tasks in `contract.decisions`. Only those tasks
   and their dependents are gated. Questions that actually prevent a coherent
   specification still block acceptance; do not invent answers or erase blockers.
5. **Authorize development in this same session.** Run `/waicc-develop` after plan
   acceptance or a fresh specification PASS. No close/reopen/new contract is needed.
   Main codes by default; `--delegate` selects optional coordinated coding. The
   coordinator implements the entire authorized plan in dependency order,
   runs relevant checks and inspects the whole diff. No per-task or batch handoffs.
   Genuine remaining blockers must be resolved before claiming all work is done.
   A planning-only request still stops at `PLAN_READY`; accepting a plan grants no new authority.
6. **Review the whole implementation once.** `/waicc-review Review authorization, regressions and test evidence`
   asks the main agent to check completion, then produce ONE code-review handoff.
   Its completion report must cover every task, actual checks/limits and all earlier
   actionable findings. Send the copied prompt to a reviewer, then `/waicc-continue`.
   The reviewer inspects actual code changes, not merely the plan or contract.
7. **Fix everything before re-review.** If review fails, the coordinator assesses
   `needs_changes` before editing, fixes ALL findings, completes checks and requests
   ONE fresh whole-change review. Repeat until no actionable findings remain—not
   one handoff per fix. Real blockers and the explicit round limit still stop the loop.
8. **Close explicitly.** A passing whole-change assessment shows `READY_TO_CLOSE`
   and `contractReview: PASS`. Run `/waicc-close <reason>` only when you decide the
   contract discussion is finished. This does not certify code delivery.

```mermaid
flowchart TD
    A[Requirements and project evidence] --> B[Versioned contract and handoff]
    B --> C[Chosen agent writes a reply]
    C --> D[waicc-continue validates and assesses]
    D --> E[Follow-up or revised contract]
    E --> C
    D --> F[Plan accepted: PLAN_READY]
    D --> G[Blocker or clarification]
    F --> M[Human: waicc-develop in SAME session]
    M --> H[Main agent finishes ALL planned code and checks]
    H --> I[ONE independent whole-change code review]
    I --> L[Findings: main agent fixes ALL and checks]
    L --> I
    I --> J[Review PASS: READY_TO_CLOSE]
    J --> K[Human runs waicc-close: CLOSED]
```

Use one session for one development objective, with multiple request/reply rounds.
`/waicc-status` shows the current state, pending reply, last assessment and next
action. After an interruption, use `/waicc-use <session-id>` to resume.

Planning `coverage: addressed` means the source-backed plan covers the requirement,
not that code is implemented or tests pass. No builds/tests does not automatically
make all planning unverified. Actual checks retain passed/failed/not_run and their
limits; deliveryVerified stays false. A grep hit is not proof of behavior.

Owner/planner/reviewer/advisor all receive source-first instructions. The owner must
save adopted revisions, carry decisions forward and avoid unchanged follow-up loops.
Schema validity cannot independently prove investigation quality or human approval.
Code-review completion reports are evidence-backed coordinator claims, not proof;
the reviewer independently verifies them. Unavailable checks stay `not_run` with
limits; missing required evidence is a blocker, not a fabricated pass.

### Review an existing change: a commit, a range or SVN revisions

To review code that was not built in a WAICC session, name the change:

```text
/waicc-review --rev abc123 Check the paging fix          # one Git commit
/waicc-review --rev main..feature/search                 # every commit on feature/search not on main
/waicc-review --rev main...feature/search                # what the branch added since it split off (as a pull request shows it)
/waicc-review --rev r1234:r1250 Check the export         # SVN: the changes made in r1234 through r1250
/waicc-dispatch                                          # then review as usual
/waicc-continue
```

WAICC checks the range against the repository (a typo or an empty range starts nothing), starts
its own review session, and asks the main agent to describe what the change is meant to do; the
main agent does not edit or judge it. Every code review in that session then carries the change
itself: WAICC runs `git diff` or `svn diff` and puts `changes.patch` and `commits.txt` (the commit
messages) beside the handoff, so any reviewer sees exactly what changed, including Claude and Pi
reviewers that cannot run commands. In a monorepo sub-project only that project's files are
included. A patch over 400,000 characters is cut, and the reviewer is told to read the remaining
files from the checkout. If the reviewer finds problems, the fixes and re-reviews work as usual,
and each re-review carries the original change plus the fixes. `/waicc-export` includes both
files.

### Review a merge request

```text
/waicc-review --mr 123 Check the sync logic      # GitLab merge request !123 (or GitHub pull request #123)
/waicc-dispatch                                  # the review role's profile reviews it
/waicc-continue                                  # the main agent assesses each finding
/waicc-review --mr 123                           # after the author pushes fixes: fetch again, re-review
/waicc-review --mr --list                        # pick one from the list instead of typing its number
```

`--mr --list` (or `--mr list`, with `--remote <name>` if needed) lists the merge requests to pick
from; picking one starts its review as `--mr <number>` would. With your GitLab host set up (see
the token below) it shows the open ones, most recently updated first, with title, author,
branches and age. If `GITLAB_TOKEN` is set but the host is not listed yet, it offers to list it
first. Without a token, git can only list the newest 30 numbers, which may include merged or
closed ones, and the list says what is missing. Either way, a merge request a WAICC session here already reviews is
marked with that session's state.

**GitHub:** pull requests are fetched and reviewed the same way (`--mr 45` reads
`refs/pull/45/head` when the remote is on github.com). Listing them with titles and posting
comments are GitLab only for now.

WAICC fetches the merge request with plain `git fetch`, no token needed: GitLab publishes
every merge request as `refs/merge-requests/<n>/head` (GitHub as `refs/pull/<n>/head`). It
lands in WAICC's own refs (`refs/waicc/mr/<n>/…`), so your branches and working folder are not
touched, and git never prompts for a password (a missing login fails instead of hanging). The
review covers what the merge request would merge: from where it split off its target branch to
its head. The target is the remote's default branch unless you give `--into <branch>`; with
several remotes, WAICC uses `origin` or the one you name with `--remote <name>`.

No `/waicc-init` is needed: in a monorepo, start Pi at the repository root (or any folder not
initialized as its own project) and the whole repository is the project, so a merge request
across several services is reviewed as one change. The main agent scopes the review with one
task per service it touches, and a large change across several folders also gets one patch per
folder (`changes/services_orders.patch`, …) so a size limit never hides a whole service. The
reviewer cites each finding as `path:line`, ready to become a comment on that line. WAICC
keeps its own files in `.pi/pi-waicc`, which is ignored by Git, so nothing appears in the
repository's changes. Running the same command again in that session fetches the author's new
commits; the next review then covers them, with every earlier finding marked fixed or disputed.

**Post the review to GitLab, after you confirm.** Once the main agent has assessed the review:

```text
/waicc-mr-comments
```

shows how many findings there are to post and lets you choose: post them all, choose one by
one, post only a summary, or cancel. A last confirmation names the merge request before
anything is sent. Each finding whose evidence starts with a changed file's `path:line` becomes a
comment on that line; the rest, and any line GitLab will not accept a comment on, go into one
summary comment with the review's outcome, worst first. Findings the main agent disputed and
mere notes are never posted. WAICC records what it posted in the session, so after the author
pushes fixes and you review again, only new findings are offered. It refuses when the merge
request has new commits since the review (fetch and review again first), when it is no longer
open, or without Pi's interactive screen. Only you can post: it is a command, never a tool the
main agent can call.

It needs a GitLab personal access token with the `api` scope, set per host in your user file
(a project file setting `gitlab` is rejected, so a repository cannot point your token at its own
server):

```json
"gitlab": {
  "gitlab.example.com": { "tokenEnv": "GITLAB_TOKEN" },
  "10.0.0.5": { "tokenEnv": "GITLAB_TOKEN", "allowHttp": true }
}
```

**You do not have to set this up by hand.** The first `/waicc-mr-comments` for a host that is
not set up walks you through it, asking at each step:

1. **Add the host** to your user file (and, for a plain `http://` host, whether to allow the
   token over http).
2. **Create the token:** it opens GitLab's token page in your browser, filled in with the name
   "WAICC reviews" and the `api` scope; you pick an expiry date, create it and paste it into Pi.
3. **Check and keep it:** WAICC checks the token with GitLab (it shows which account it signed in
   as), then offers to keep it: on Windows as the `GITLAB_TOKEN` variable in your user settings
   (what `setx` does), elsewhere in your user file, readable only by you. Say no and it works for
   this Pi session only. It then posts the review in the same run.

A token GitLab refuses is never saved. The token is never shown in the chat, and it is never put
in Pi's own environment, so agents WAICC dispatches do not inherit it. Everything else in your
user file is kept, and a host already listed is never replaced.

To do it by hand instead, create the token in GitLab: your avatar → **Preferences** → **Access tokens** → **Add new
token**, tick the **api** scope, and copy it. Then keep it in an environment variable rather than
the file. On Windows, in PowerShell:

```powershell
setx GITLAB_TOKEN "glpat-..."     # saved for new windows; close and reopen the terminal, then start Pi
```

On macOS or Linux, add `export GITLAB_TOKEN="glpat-..."` to your shell profile (`~/.zshrc` or
`~/.bashrc`). `/waicc-dispatch --profiles` then shows `from GITLAB_TOKEN` for the host.

`tokenEnv` names an environment variable that holds the token; `token` holds it in the file
itself. If your remote's address only redirects to the real server (for example
`http://10.0.0.5` forwarding to `https://gitlab.example.com`), WAICC finds that out first with
one request that carries no token, and then uses and asks about the server it lands on, so the
token goes encrypted to the real host. It never follows a redirect with your token. A host reached over plain `http://` needs `"allowHttp": true`, because the token would
travel unencrypted. WAICC trusts the system's certificates as well as Node's, so an internal
GitLab that git and your browser trust works. With the host set up, `/waicc-review --mr` also
reads the merge request's title and description, so the main agent knows what it is meant to
do. `/waicc-dispatch --profiles` shows whether each host has a token, never the token.

For specification-only work, explicitly use `/waicc-review --contract <focus>`.
That review may retain future execution gates and its PASS is not code approval.
`reviewApproval.kind` distinguishes `code` from `contract`; legacy unmarked reviews
remain specification-only and are never silently upgraded.

### Automatic planning — on by default

Describe work normally—no setup command is required. For example: “Rename this
setting, update its documentation, then check both agree.” The main model plans
whenever tracked steps would help it keep the work on track, **not only for complex
tasks**. Multiple meaningful steps, dependencies, separate completion checks or
changes that must stay coordinated are enough. Keep the plan proportional to the job.

WAICC captures your input using `waicc_start_planning`, saves important prior
context and prepares one planning brief/handoff. The planner investigates the code
and returns the detailed plan. This uses the current model's normal turn, not an
extra classifier or worker process.

To show the current setting, turn it off, or re-enable it:

```text
/waicc-auto-planning
/waicc-auto-planning off
/waicc-auto-planning on
```

Trivial one-step edits, explanations, status questions and exploratory discussion
should not start new contracts. Whether tracked planning would help is model judgment,
not a guaranteed classifier.
Put `[no-plan]` at the beginning of a message to mechanically skip automatic startup
for that input. It does **not** bypass an existing contract's scope or coding guards.
Manual `/waicc-planning` is always available.

Related follow-ups use the selected contract unchanged. Pending packets are not
rewritten or duplicated; unrelated/new scope needs an explicit human choice. If
no contract is selected but open sessions exist, WAICC asks for `/waicc-use <id>`
or an explicit new `/waicc-planning` rather than choosing for you. Closed, deleted
or missing selections are never silently replaced.

The setting defaults **on**, including new chats and existing branches without a
saved preference. Explicit `off` preferences remain off across reload/resume;
use `on` to re-enable. Overrides apply only to this Pi chat/project branch. Old
`complex` commands/settings remain compatible as an alias for `on`, using the new
step-tracking policy. Startup requires a fresh idle human prompt
(interactive or RPC). Slash commands, extension-generated/custom messages,
transformed inputs and queued/steered messages do not trigger startup; send a fresh
ordinary prompt when needed. Handoff recipients cannot enable or use it.

The handoff still uses the existing clipboard/manual-copy flow. Send it to your
chosen planner, then `/waicc-continue` in the coordinator. Auto-planning never
launches another agent, adopts a reply, amends scope, confirms memory, closes a
contract or authorizes implementation. After plan acceptance, you still explicitly
run `/waicc-develop`.

### Specification approved, now develop

`SPEC_APPROVED` means specification review PASS, not code completion or permission.
`/waicc-develop [--main|--delegate]` explicitly accepts/authorizes the current ready
plan and changes objective to development. It records version, requirements, paths,
source baseline and provenance without changing the contract or consuming a round.
`READY_TO_IMPLEMENT` has no unresolved decision gates; `IMPLEMENTATION_GATED` has a
valid grant but still-blocked tasks. Main may do genuinely unblocked authorized work;
whole-plan delegation and full code review wait until gates are resolved.

**Decisions** (`D1`, `D6`, …) are choices the plan cannot make on its own. Each has an owner:
`agent` decisions are facts the agents settle by investigating the code; `human` and
`external` ones need a person, such as permission to touch a staging system, a fact only
another team knows, or a product choice. An open decision blocks only its affected tasks
and their dependents. Agents never record the answer to a human or external decision: the
main agent tells you the exact command, the question and its recommended answer.

`/waicc-decisions` shows the consolidated owners, evidence, recommendations and
affected tasks. `/waicc-decide D1 <answer>` records an existing gate's answer as a
versioned human decision with an audit, not an automatic scope amendment. To agree
with the agent's recommendation, you do not retype it:

```text
/waicc-decide D1 recommended      # D1's recommendation becomes your answer
/waicc-decide all recommended     # every open decision, after one dialog listing them
/waicc-decide                     # pick a decision, then "Accept the recommendation" or type your own
```

Saying "go with your recommendation" in chat is not enough: the agent cannot record
decisions, so it gives you the `recommended` command instead. IDs match regardless of case (`d6` is `D6`). An answer typed without
its ID is confirmed for the only open decision; with several open, or a wrong ID, WAICC
lists the open decisions and records nothing. Pending
handoffs must be finished/cancelled first. The command cannot change task/path/scope
fields or replace an already established answer. It may explicitly repin a current
grant for that narrow answer-only revision, but never carries review PASS. Ordinary
revisions/amendments invalidate authority and require renewed `/waicc-develop`.

#### Fewer decisions to answer: standing policies and low-risk auto-accept

Two opt-in settings in your **user** agent config (`~/.pi/agent/waicc-agents.json`; a
project file that sets them is rejected) answer routine decisions for you, so only the
ones that really need you are left:

```json
{
  "policies": [
    "Prefer framework-native solutions; do not add new dependencies",
    "Never use staging or production systems without asking"
  ],
  "autoDecide": "low-risk",
  "profiles": { … },
  "roles": { … }
}
```

- **Standing policies are your rules, given in advance.** The main agent sees them, and
  when an open **human-owned** decision is clearly and fully answered by one, it records
  the answer with `waicc_apply_policy`, citing the policy number and why it applies. It must
  not stretch a policy or combine policies, and a policy never answers an `external`
  decision. Each one is announced in the chat and recorded as "resolved by standing policy".
- **`"autoDecide": "low-risk"` accepts the agent's recommendation automatically** for
  decisions the planner rated low risk and reversible, after each assessment and on
  `/waicc-develop`. It is announced and recorded as "accepted automatically".
- **Always yours, whatever the settings:** `external` decisions, anything not rated low risk
  or not reversible, and anything mentioning access, credentials, staging or production,
  deployment, money, deleting or migrating data, security, permissions, privacy or legal
  matters.
- `/waicc-decide auto` runs the low-risk check now and explains, decision by decision, why
  each remaining one still needs you. `/waicc-decisions` shows how every decision was
  resolved.

Risk ratings come from the agents: the planner proposes them and the main agent may revise
them when it adopts the plan, so a decision can become low risk during assessment. The
hard rules above (external, not reversible, sensitive subjects) cannot be overridden by any
rating, and every automatic answer is announced so you can review it.

Verified live with a Pi main agent (DeepSeek V4 Pro): with a policy against new
dependencies, it answered "add lodash or use built-in string methods?" with
`waicc_apply_policy` citing that policy; with `autoDecide: low-risk`, two low-risk
decisions were accepted automatically and announced, and the external decision stayed
open for the human.

Why not a confidence score: a model's confidence is not calibrated, and many decisions
are about authority rather than certainty. An agent can be sure you would allow a staging
check, and it is still not your permission. Rules you wrote, and a risk rating backed by
evidence with sensitive subjects excluded, are what make an automatic answer safe.

Status exposes objective/phase, plan acceptance, separate spec/code reviews, recorded
implementation authorization and its reason, open gates, reported task counts and
phase/overall round budgets. Unknown progress is `null`, not zero; reported completion
is not verification. Legacy specification records keep their history and can use the
same development command; omitted old review kinds display `legacy_contract`.

New Pi/CLI sessions start planning-only with an overall 20-round cap and phase caps
(specification 8, implementation 6, testing 4, code_review 8, advisor 4). Both limits
apply. `/waicc-limit code_review 10` changes that phase explicitly; `/waicc-limit 20`
changes only the overall limit. Existing caps are retained; transitions/answers
never reset usage or silently raise limits. The low-level API retains legacy behavior
when objective is omitted for backward compatibility; new integrations should pass it.

The grant does not create OS isolation, production authority or shell permissions.
Coordinator edit/write guards honor it; agents must not bypass it using other tools.

## Optional coding and testing handoffs

The main agent codes by default. To keep it as coordinator from the start:

```text
/waicc-planning --delegate Add customer search with account isolation. Preserve the existing API.
```

After plan adoption, `/waicc-develop` authorizes work in the same session, then the
coordinator prepares ONE whole-plan handoff when execution gates are resolved. You can also
select delegation later with `/waicc-help-develop [focus]`. This means implement the
entire accepted plan—or ALL outstanding fixes—not one task at a time. The coding
agent should run relevant permitted checks and return a whole-work completion report.
`/waicc-implement` remains a compatibility alias with the same options and safeguards.
`/waicc-continue` makes the coordinator inspect the actual diff, coverage, fixes and
check evidence before deciding what is next. It does not blindly turn a ready reply
into review PASS or immediately send completed code back for implementation.
Delegation is optional: the contract owner can always do the authorized work.
To return a delegated role to the main agent, use `/waicc-help-develop --main [focus]`
or `/waicc-test --main [focus]`. Finish/cancel a pending assignment first; changing
ownership does not stop an external worker. These switches create no new handoff.

If checks are missing, the main agent can run them itself. Optionally use
`/waicc-test [focus]` to delegate ONE consolidated testing assignment. A tester runs
permitted checks and reports results; it does not edit code/tests or implement fixes.
Unavailable checks remain not_run. Implementation with unrun checks can reach
NEEDS_TESTING; supported implementation/testing reaches NEEDS_REVIEW, never PASS.
Finish ALL fixes/checks before ONE independent full code review. A separate tester
is optional, not a mandatory handoff on every cycle. Neither command launches agents.

Every new handoff includes CONTEXT.md/context.json, original requirements and all
amendments, complete saved round conversation, prior findings/checks, relevant skills
and a confirmed-memory snapshot. Recorded local check logs travel under evidence/.
The owner saves important chat-only domain facts, constraints, references and decision
rationale with waicc_context before dispatch; uncaptured chat cannot be recovered.
The context packet supplements—not overrides—the contract or permissions. Large Pi
assignments point to the full saved files instead of injecting an oversized history.

### Automatic checkpoints and compact context

WAICC automatically saves `CHECKPOINT.md` (small recovery brief) and `checkpoint.json`
(complete ID/evidence index) with workflow transitions, including plan adoption,
implementation/testing/review assessment and each new handoff. Records are derived
from canonical state, not repeatedly summarized from an older summary. Requirement,
task/acceptance, decision and finding IDs, source/version labels and original evidence
references remain recoverable. Full history and test logs stay on disk, not in every prompt.

Pi still owns chat compaction and its normal automatic threshold. WAICC validates
recovery evidence before Pi compacts and supplies a compact checkpoint on the next
model request (including mid-run overflow retries), or after session reload. It does not install a second threshold,
delete history, create another handoff, change ownership or automatically approve work.
Corrupt recovery evidence cancels compaction with an error instead of hiding it.

For an immediate manual compaction in the selected chat:

```text
/waicc-compact
```

Optionally append important chat-only context first:

```text
/waicc-compact Keep the old API shape because older mobile clients are still supported.
```

Notes append to saved coordinator context and remain supplementary claims, not new
requirements. Notes cannot be saved while a handoff is pending or from recipient mode;
plain `/waicc-compact` still works without altering that frozen packet. Closed sessions
remain read-only. Recipients recover only their exact issued checkpoint, not a newer
owner assignment, and compaction never widens editing/check permissions.

Agents can call `waicc_checkpoint` for read-only compact recovery and expand exact
contracts/original evidence when needed. Full code review must still cover every
requirement/task/acceptance criterion and every prior actionable finding. Old checks
are not proof for changed code; failed/not-run limits and source mismatches stay visible.
Automatic indexing cannot capture unsaved chat-only decisions: save them with
`waicc_context` when allowed; Pi retains/summarizes its own chat. No short summary is
a guarantee of lossless chat recall.

CLI `waicc checkpoint <session-id>` reads recovery state. `waicc compact <session-id>`
validates/creates the checkpoint only; it does not compact a Pi chat. Portable exports
include the frozen checkpoint and exact indexed originals under `archive/`; checkpoint
artifact paths resolve relative to that folder. Source access is still needed separately.

### Review findings must be useful to fix

Reviewers are instructed to provide `{id,severity,description,evidence,suggestedFix}`:
explain the defect/impact, cite source path and line/symbol or actual failing check,
identify the triggering case and expected versus observed behavior, then recommend
a minimal in-scope fix and regression verification. Static source proof is valid;
an unrun reproduction must never be described as executed. Unconfirmed suspicions
stay labelled as such. Evidence is mandatory, and the owner independently verifies it.

`suggestion`, `recommendation`, `fix` and `suggested_fix` can be normalized into
suggestedFix, with original annotations/raw replies preserved. Suggested fixes are
advice—not executable commands, permission or automatic scope changes. Older replies
without suggestions remain readable; the owner investigates and derives a supported
remedy instead of requiring another handoff solely to rewrite the reply.

## Manual handoff: exactly what to give

When a handoff is ready, the main agent shows only a short table of next steps, not the
prompt itself:

| Step | Command |
|---|---|
| Send it to an agent, headless | `/waicc-dispatch` (it names the profile its role uses, e.g. *your opus profile*; `--implement` for coding) |
| Or give it to an agent yourself | `/waicc-handoff` (shows the prompt to paste, and copies it) |
| When its reply is in | `/waicc-continue` |

### Pick a command instead of typing it

The main agent cannot run slash commands. When it needs you to run a WAICC command, such as
the steps above or `/waicc-develop` when it is stuck, it offers them in a picker:

```text
The agent suggests running a WAICC command
> /waicc-dispatch  ·  send the plan review to your opus profile
  /waicc-handoff  ·  show the prompt to give an agent yourself
  None of these
```

The picker opens once the agent's turn has ended, so leaving it open holds nothing up. Pick
one with the arrow keys and Enter, and it runs once, exactly as if you had typed it, so
anything it approves is still your approval. Nothing is put in your input box, so an extra
Enter does nothing, and anything you were typing is kept. Escape or *None of these* runs
nothing. If the agent starts working again, for example when a dispatched agent's reply
arrives, the open picker is withdrawn, since the agent may offer something else. Only real
`/waicc-*` commands can be offered, and the commands stay listed in the chat. You can still
type any command yourself, for example to change a flag first.

Run this in the coordinating Pi chat whenever you need clear copy/paste instructions:

```text
/waicc-handoff
```

Or specify `/waicc-handoff <session-id>`. It displays a **copy-only prompt block**
and keeps the human's return steps outside it. This does not start inference,
issue another request or change the contract. It also works for existing pending
handoffs without rewriting their committed files.

Interactive Pi automatically copies **only the recipient prompt** for a new handoff.
Paste with Ctrl+V (Cmd+V on macOS). `/waicc-handoff` copies again on demand; ordinary
status/use reads do not repeatedly overwrite the clipboard. Export copies the portable
prompt; it still needs the entire export folder and matching source. Replies do not copy.

This reuses Pi's Windows/macOS/Linux clipboard support (native helpers, Wayland/X11,
WSL and supported terminal forwarding). Linux may need wl-clipboard or xclip/xsel
and display access. Remote OSC 52 depends on terminal permissions and cannot be
independently confirmed. Missing clipboard access is reported in one line pointing to
`/waicc-handoff`, never by dropping the whole prompt into the chat, and it never
invalidates the handoff. RPC/JSON/print modes do not write the host clipboard
or emit clipboard control sequences. Tests mock the writer rather than live macOS/
Linux desktops; no OS packages are installed automatically. Copying replaces the
clipboard's existing text.

- **Same computer/project access:** open the other agent in the project, then paste
  the complete prompt block (or the **contents** of `STARTER.txt`). Do not give it
  just the file path or the coordinator's entire status/assessment message.
- **Files to read, not separately paste:** the prompt points to `HANDOFF.md`, which
  links requirements, contract, conversation, skills and reply template. The agent
  needs permission to read these hidden/ignored `.pi/pi-waicc` files.
- **Different computer/no local-path access:** `/waicc-export`, provide the **entire
  export folder**, and paste its `STARTER.txt` contents. Provide access to matching
  source separately; the export contains no code. A `HANDOFF.md` attachment alone
  does not include the other inputs. Review content before sharing.
- **After the reply:** return to the coordinator for this session and run
  `/waicc-continue`. If its selection is different, first `/waicc-use <session-id>`.
  These are your return steps, not commands to send to the recipient.

Only use one recipient per request. When `reply.json` already exists, the copy view
is withheld and status directs you to intake/validation, not another handoff. A
failed validation may require an explicitly requested reply repair, not a new worker.
`waicc_status` exposes the same instructions as `manualHandoff` before the large
contract body, so the coordinator can present them even with a bounded tool preview.

## Receive in another Pi chat

You can use different models for the two roles without launching another process
from WAICC. For example, prepare the contract with DeepSeek in Pi chat A, then
manually open Pi chat B in the **same project checkout**, select Claude using Pi's
normal model controls, and run:

```text
/waicc-receive <session-id>
```

Use the WAICC session ID from `/waicc-status`, not a Pi chat ID. The receiver finds
that session's single waiting request and pins its request ID, contract version,
requirements digest, source fingerprint and mode. It loads the original scope,
handoff, exact contract, saved context, complete conversation, selected skill paths
and the confirmed-memory snapshot frozen at issue. The current Pi model performs the recipient role.

The recipient submits through `waicc_reply` and stops. Back in coordinating chat A:

```text
/waicc-continue
```

Submission only writes the designated `reply.json`; it does not import, assess,
revise or close the contract. The coordinator validates and assesses the reply as
usual. External CLI/agent handoffs remain available using `STARTER.txt` and the
same reply format. Choose one recipient per request: receiving is not a worker
reservation, and multiple workers could duplicate investigation. The first reply
file wins; the receiver never overwrites an existing reply.

Recipient mode exposes read/search tools, confirmed-memory recall and reply
submission. It blocks coordinator mutations and shell/MCP/custom execution tools.
Planning, review and advisor recipients cannot edit source. For an implementation
request, **only if you want this Pi chat to edit the assigned code**, opt in with:

```text
/waicc-receive <session-id> --implement
```

This also enables direct `edit`/`write`, restricted to the request's task paths.
General shell/MCP/custom execution remains blocked. To optionally run local checks:

```text
/waicc-receive <session-id> --implement --run-checks
```

For a testing-only assignment use `/waicc-receive <session-id> --run-checks` instead.
`waicc_check` requires interactive confirmation of EACH exact program/argument list,
runs at project root and logs actual exit/output plus source fingerprints. No UI or
approval means not_run. This opt-in is not restored on reload; explicitly receive
the same request with --run-checks again. Other execution tools remain blocked.
Commands/scripts can write files, contact services and spawn processes with your
account permissions: this is not an OS sandbox. No production, installs, credentials,
resets or deployment. A tester changing source gets a failed check and must stop
for a fresh handoff; WAICC never automatically reverts files. External coding/test
agents keep their own permission model, never extra authority from the prompt.

The recipient binding survives Pi chat resume. It never automatically receives a
newer request: cancelled, replaced, closed or answered assignments stop. Source
freshness is checked at receive and submission; implementation may change source
within its assigned scope, checked again at coordinator intake/assessment.
`waicc_status` in recipient mode recovers the pinned assignment. To deliberately
leave that role, the human runs `/waicc-use <session-id>`; this restores the chat's
previous active tool selection. Switching provider/model remains a normal Pi action.
WAICC launches no agent on its own and runs no background scheduler; only your explicit
`/waicc-dispatch` starts a recipient process, and only an explicitly opted-in,
individually confirmed local check launches a check program.

## Dispatch to a headless agent

Instead of copying the handoff into another agent, you can have the coordinator run
it headless with the agent and model you choose. Pi still does every assessment and
you still make every decision. A typical mixed-model session:

```text
/waicc-planning Add customer search with account isolation.
/waicc-dispatch --via claude --model opus            # Claude plans
/waicc-continue                                      # Pi assesses; you accept → PLAN_READY
/waicc-develop                                       # main agent codes
/waicc-review Check authorization and regressions
/waicc-dispatch --via codex -m gpt-5.5               # Codex reviews (a different model family)
/waicc-continue
```

`/waicc-dispatch --via claude|codex|pi|agy [--model <model>] [--timeout <minutes>] [--implement] [--check "<command>"]... [--check-timeout <minutes>]`
runs the selected session's single waiting handoff in the background. This chat stays
usable; you are notified when the agent finishes, then run `/waicc-continue`.
`/waicc-dispatch --stop` ends a running agent. The CLI equivalent runs in the
foreground: `waicc dispatch <session-id> --via codex`.

**Watch it work.** While the agent runs, a live panel above the editor shows what it is
doing, and the footer shows the agent and elapsed time:

```text
WAICC · codex gpt-6.1-sol (medium) reviewing · 1m 42s · 16 steps   (/waicc-dispatch --progress, --stop)
     14s  › Reading src/search.ts
     15s  › Searching for "accountId" in src
     35s  ◆ Validating the draft reply
     35s  ✗ Draft rejected: proposedContract: Task contains unsupported fields …
         says: Fixing the task fields, then validating again.
```

`›` is a file or command step, `◆` a WAICC step (receiving the assignment, reading the
handoff, running an approved check, validating or submitting the reply), `✗` a rejected
draft or check with the reason, and `says:` the agent's latest message. The panel keeps the
last five steps; `/waicc-dispatch --progress` lists every step so far. The panel and status
clear when the agent finishes. The CLI prints the same steps to stderr as they happen.
Every step and the agent's last message are also saved in the run's `dispatch/<id>/result.json`.
Progress comes from each agent's own event stream (Claude `stream-json`, Codex `--json`,
Pi `--mode json`, Antigravity `stream-json`).

**Watch every project on one page.** Run `/waicc-tracker` and your browser opens one page
that shows every project where Pi runs WAICC, kept up to date by each Pi chat:

- **At the top,** across all projects, three boxes: **Now** (agents working and how many
  things need you), **Spent** (dollars, tokens and runs, and who spent it) and **Tokens**
  (split into fresh input, cached input and output, and who used them: main agent,
  dispatched agents, advisor). Spent and Tokens each switch between **Today**, **7 days**
  and **All** (everything recorded, with the date it starts); the page remembers your
  choices. The Spend tab shows the same split for today, 7 days and all time.
- **Needs you:** every decision waiting for your answer and each session's next step for you
  (review passed, plan ready, a reply to assess), with the command to type.
- **A card per project:** the main agent's model, the agent at work (agent, model, effort,
  loop cycle, elapsed time, its last steps), or the session's status when idle, its task
  progress and today's spend. Projects at work come first. The main agent shows here too
  while it works on a turn: "Main agent · claude-opus-5-5 working", how long, its last steps
  ("Reading src/menu.tsx", "Running npm test") and its latest message; it disappears when the
  turn ends. A review of a merge request or a `--rev` range shows what it reviews
  ("MR !7 → develop", linked to the merge request), what was posted to GitLab, and, under
  Needs you, when an assessed review is ready to post.
- **Click a card** for its tabs:
  - **Overview:** what the agent is doing step by step and its latest message; the main
    agent in each Pi chat in the project (model now, other models used, spend today and in
    all); recent run results; and each session's requirements, tasks (marked when the coder
    reports them done) and budget bar.
  - **Timeline:** every round (plan, review, fixes, re-reviews) with agent, result,
    findings, checks, time and cost.
  - **Decisions:** open ones first, with recommendations and the command to accept them.
  - **Spend:** today, 7 days and all time; a 7-day chart; and totals by who (main agent,
    agents WAICC sent work to, advisor), by agent and model, by step (planning, code review,
    testing…) and by session.
  - **Advisor:** the main agent's questions when it was stuck, and the answers.

Costs are what each agent reports about its own run, so they are as accurate as its prices:

- **Pi** (the main agent and Pi agents) reports dollars at its provider's prices, part by part
  (input, output, cache reads). A model with no price set reports $0; the page shows that as
  "without a price" rather than free.
- **Claude** reports dollars at API prices. When it runs on your claude.ai subscription (no API
  key), that is what the run would cost at API rates, not money spent per token, so the page
  marks it **API-equivalent**.
- **Codex** reports tokens only, shown as "tokens only".
- A run stopped before it finished may report nothing (Claude reports its totals at the end).

The same figure appears in Pi when a run finishes, for example
`codex submitted a reply ($0.75 · 443k tokens)`. The main agent's figures are every message it
sent in that project's Pi chats, WAICC work or not, as Pi records them; they are shown as
messages rather than runs and never count toward your budget.

**Speed:** for the main agent, output tokens per second of producing its replies (from when
each request started to when its reply was saved, so short replies, mostly waiting for the
first token, weigh little), per Pi chat in the Main agent table and per model on the Spend tab.
For dispatched agents and the advisor only output per minute of the whole run is shown, since
their time includes reading files and running commands.

The page is `~/.pi/agent/waicc-tracker/index.html` (beside your profiles). It refreshes itself
every 3 s and needs no server: each Pi chat writes its project's status into that folder.
Keep it open in a tab, or open it again any time. Nothing leaves your computer. Updating it
takes about 10 ms, at most once every 2 s, and never while WAICC is saving. If writing it ever
fails, WAICC carries on. A card whose agent stops reporting for 90 s says Pi may have
closed. Projects not seen for 14 days drop off. `/waicc-tracker off` stops every chat
from updating it; `/waicc-tracker on` turns it back on.

**Continue automatically.** Add `--continue` (short: `-c`) and, when the agent submits a valid reply,
WAICC runs the `/waicc-continue` step for you: the reply is validated and the main agent
starts assessing it. If the main agent is busy, the assessment waits for its current turn.
It only saves you the command: accepting a plan still leaves coding to your
`/waicc-develop`, and nothing is ever closed for you. To make it your default, set
`"autoContinue": true` in your user agent config (see [Agent profiles](#agent-profiles-choose-an-agent-per-role-once));
`--no-continue` turns it off for one run. A project's config cannot turn it on. The CLI's
`--continue` validates the reply into `AWAITING_ASSESSMENT`, since there is no main agent.

**Review until it passes: `--loop`.** For a waiting code review, `/waicc-dispatch sol --loop`
runs review → fix → re-review cycles, at most 3 by default (`--loop 5` for up to 8):

```text
/waicc-review Check authorization and regressions
/waicc-dispatch sol --loop
   → sol reviews (cycle 1/3) → the main agent assesses, fixes ALL findings, runs checks
     and requests a fresh review → sol re-reviews (cycle 2/3) → pass
   → "Review passed after 2 cycles. Nothing was closed: run /waicc-close when you are satisfied."
```

Each cycle's agent, model and cycle number show in the live panel. The loop stops and hands
back to you when:

- the review **passes** (`READY_TO_CLOSE`; it never closes the contract);
- the main agent **does not request a fresh review**, because a finding needs your decision,
  is disputed, blocked or out of scope;
- **the same findings come back** after the fixes (the reply is still assessed, but no new
  review is sent);
- the **cycle limit** is reached (a fresh review is left waiting for you);
- the reviewer submits **no reply**, or you run `/waicc-dispatch --stop`.

The main agent fixes only inside work you already authorized with `/waicc-develop`; the loop
never starts coding by itself, and never commits, pushes or deploys. It also stays within
WAICC's own code-review round budget. Each cycle is a full review plus fixes, so watch the
first few loops: if they keep hitting the limit, tighten the review focus or the plan.
`--loop` needs Pi; the CLI refuses it.

Verified live with a real Pi coordinator (DeepSeek V4 Pro as the main agent) and Claude
Sonnet reviewing a planted cross-account bug: the review found it and a missing test, the
main agent assessed, fixed both, ran the tests (4/4) and requested a fresh review, which
was dispatched automatically and passed, and the loop ended at `READY_TO_CLOSE` after
2 cycles in under 5 minutes without closing anything.

**Plan until accepted, and on through review: `--loop` on planning, `--develop`, `--review`.**
`--loop` also works on a waiting planning handoff: the planner plans, the main agent
assesses, and when the plan needs more work it asks for a revised one (`followup`), which is
sent back to the planner automatically, until the plan is accepted (`PLAN_READY`).

```text
/waicc-planning Add the status message field
/waicc-dispatch --loop 3 --develop --review
   → your planning profile (opus) plans until the plan is accepted
   → development is authorized automatically, because you typed --develop
   → the main agent codes; when it requests the whole-change code review,
     it is dispatched with your review profile (sol) as a review loop
   → "Review passed after 1 cycle. Nothing was closed: run /waicc-close when you are satisfied."
```

- **Each stage uses its own role's profile**, so planning and review run on different models:
  your `planning` and `review` roles in the agent config. Choose either for one run:
  `--plan-with <profile>` (or name the profile first) for planning, `--review-with <profile>`
  for the review.
- **`--auto` is short for `--loop 3 --develop --review`**; a typed `--loop 5` keeps its count.

  ```text
  /waicc-dispatch --auto                                          # opus plans, sol reviews
  /waicc-dispatch --auto --plan-with opus-max --review-with sol-ultra
  ```
- **`--code-with [profile]` hands the coding to another agent.** Once the plan is accepted,
  the main agent writes ONE coding handoff for the whole plan, and WAICC dispatches it
  headless to that profile (or your `implementation` role's, when you name none), in an
  isolated worktree. The main agent assesses the code but does not edit it. Review findings
  go back to the same coding agent as one fix handoff, then a fresh review runs, up to the
  loop's limit. Antigravity (`agy`) profiles cannot code yet and are refused before planning
  starts, as is a missing profile.

  ```text
  /waicc-dispatch --auto --code-with sol-ultra    # opus plans, sol-ultra codes and fixes, sol reviews
  /waicc-dispatch --auto --code-with              # your implementation role codes
  ```
- **`--review-once` stops after the first code review**, without fixing anything. The main
  agent assesses the review and tells you what it found; you decide what comes next. It needs
  `--auto` (or `--develop --review`), and works with or without `--code-with`.
- **`--develop` is your approval of the plan, given in advance for this run.** Without it the
  run stops at `PLAN_READY` and you run `/waicc-develop` yourself, after reading the plan.
  It is recorded as authorized by `--develop` on the dispatch.
- **It never starts coding while a decision is open.** If the accepted plan still has an
  unanswered decision (after your policies and `autoDecide`), the run stops and lists it:
  answer it with `/waicc-decide`, then run `/waicc-develop`.
- **Give the review its checks.** Reviewers are read-only, so without pre-approved checks they
  cannot run your tests, and a review that requires them is blocked. Set them on your
  `review` role (`"review": { "profile": "sol", "checks": ["npm test"] }`) and the automatic
  review uses them.
- **`--review` needs `--develop`**; the review stage then follows the same stop rules as any
  review loop. `--develop` without `--loop` is a single planning cycle. `/waicc-dispatch --stop`
  ends the run at any stage. The run never closes, commits, pushes or deploys.

Verified live with `/waicc-dispatch --auto`: Claude Opus 5.5 planned (accepted in one cycle),
development started automatically, the Pi main agent (DeepSeek V4 Pro) coded the function and
its test, and Codex `gpt-6.1-sol` reviewed automatically, running the review role's
`node --test` check through WAICC (6/6 passed). The review passed and the run ended at
`READY_TO_CLOSE` in under 7 minutes, without closing anything.

| `--via`  | Runs                                 | Read-only enforcement                                   | Model flag              |
| -------- | ------------------------------------ | ------------------------------------------------------- | ----------------------- |
| `claude` | `claude -p` (Claude Code)            | Edit/Write/NotebookEdit/Bash disallowed; only WAICC MCP. Coding: edits in an isolated worktree, no shell | `--model opus` |
| `codex`  | `codex exec`                         | `--sandbox read-only` (OS sandbox); only WAICC tools approved. Coding: `workspace-write` in an isolated worktree | `-m <model>` |
| `pi`     | `pi -p` with this extension          | WAICC's own recipient mode: read/search tools; with `--implement`, edit/write only inside task paths | `--model provider/id` |
| `agy`    | `agy -p` (Antigravity CLI)           | Its headless permissions deny edits and commands; only WAICC's tools on its pinned server are allowed | `--model <slug>`        |

What it does and does not do:

- **One recipient per request.** Dispatch refuses while a reply exists or another
  dispatched agent is still working on the same request.
- **Coding needs `--implement`.** Planning, review and advisor handoffs go to any agent
  read-only. A delegated implementation handoff is dispatched only with `--implement`:

  - **Pi codes in place.** WAICC's recipient mode allows edit/write inside the task's
    allowed paths and blocks every other path and all shell commands as they happen.
  - **Claude and Codex code in an isolated Git worktree.** Dispatch snapshots exactly the
    files the handoff fingerprinted (uncommitted and untracked work included) through a
    temporary index, so your checkout and staging area are untouched, and the agent
    edits only that copy. When it finishes, WAICC applies its changes **all or nothing**:
    only if a reply was submitted, every changed file is inside the task's allowed paths
    and your checkout has not changed meanwhile. Otherwise nothing is applied and the
    copy is kept for you to inspect. Codex runs in `--sandbox workspace-write` and can run
    commands without network. Claude has no shell. Isolation needs a Git checkout;
    Antigravity is refused.
  - **Dependencies are linked, not copied.** Top-level `node_modules`, `.venv` and `venv`
    folders that Git ignores are linked from your project into the copy, so tests can
    run there. They are never part of the agent's changes, and removing the copy removes
    only the link. Writes through the link (such as a test cache) land in your folder.

  ```text
  /waicc-develop --delegate
  /waicc-dispatch --via codex --implement --check "npm test"   # isolated worktree
  /waicc-dispatch --via pi --implement --model deepseek/deepseek-flash   # or in place
  /waicc-continue
  ```
- **Pre-approved checks: you choose the exact commands.** Each `--check "<command>"`
  approves one exact command (program and arguments; use single quotes inside it for an
  argument with spaces, for example `--check "node --test 'tests/a b.ts'"`). The agent
  can run only those, by number, through WAICC's `waicc_run_check` tool (Pi: `waicc_check`
  with the exact command), never through its own shell. WAICC runs each at the project
  root (in the isolated copy for Claude/Codex coding), logs its exact output, exit code
  and source state in the round, and the agent cites that result. `--check-timeout`
  allows 1–30 minutes per check (default 10); at most 10 checks.
  - **Testing handoffs can now be dispatched,** with at least one `--check`; the tester
    stays read-only. A test run that changes source fails, as with interactive checks.
  - **Coding agents can run them too,** to verify their own work before submitting.
  - **Code reviewers can run them too,** staying read-only: a review that requires tests to
    run otherwise has to report them `not_run` and is usually blocked. A reviewer's check that
    changes the reviewed source fails, as a tester's does. Give your `review` role its checks
    so automatic reviews (`--review`, `--auto`) get them:
    `"review": { "profile": "sol", "checks": ["npm test"] }`.
  - By default checks run with your account's permissions: approve only local, reviewed
    commands, never deployments, installs or anything using secrets. Antigravity cannot
    receive pre-approved checks.
  - **Optional OS sandbox** (user file only): `"sandbox": { "checks": "auto" }` runs every
    check so it can write only to its working folder (the project or the isolated
    worktree), the temp folder and any `"allowWrite"` folders (for example
    `["~/.npm", "~/.gradle"]` for tool caches), with no network unless `"network": true`.
    It uses `sandbox-exec` on macOS and bubblewrap (`bwrap`) on Linux. Windows has no
    sandbox WAICC can use yet. Where none works, `"auto"` runs the check as before and the
    result says so; `"required"` refuses to run it and the agent reports it `not_run`. Each
    check result records the sandbox that ran it, its writable folders and whether network
    was allowed.

  ```text
  /waicc-test
  /waicc-dispatch --via claude --check "npm test" --check "npm run lint"
  /waicc-continue
  ```
- **The agent is pinned.** Claude and Codex get a per-run WAICC MCP server that refuses
  every request except the dispatched one; Pi pins it at startup.
- **Replies are validated before they are written.** Agents check drafts with
  `waicc_validate_reply` (Pi: `waicc_reply` with `validateOnly`) and fix every reported
  problem before the single submission, so `/waicc-continue` receives a valid reply.
  Planning and review assignments include a valid `proposedContractExample`. Validation
  reports every independent problem at once, each with where it is (such as
  `proposedContract.tasks[0].acceptance[1].verification`), so an agent fixes a draft in one
  pass instead of one problem per try; an invalid proposal also shows that example.
- **Audit log.** Each run records the agent, model, exact arguments, exit code and
  output tail under the round's `dispatch/<id>/` folder.
- **Never assesses, accepts, closes or retries.** A failed run leaves the handoff
  waiting: read the log, dispatch again, try another agent, or hand it off manually.
- **Sign in first.** Each CLI must already be installed and signed in; headless runs
  cannot log in. On Windows, npm/Volta `.cmd` shims are supported.
- **Source must match the handoff.** If source changed since the handoff was issued,
  dispatch refuses and asks for a fresh handoff. A reviewer that edits code anyway
  cannot submit: its reply fails the source-fingerprint check.

Context travels through the saved session files, not chat: every dispatched agent
reads the same requirements, contract, saved context, complete round history, prior
findings, skills and confirmed memory as a manual recipient. Save important chat-only
facts with `waicc_context` (or `/waicc-compact <note>`) before dispatching.

Verified live on Windows 11 with Claude Code 2.1 (Sonnet), Codex CLI 0.163 and Pi 1.2.0
(DeepSeek V4 Pro): each pinned the request, corrected rejected drafts through dry-run
validation, submitted once and left source untouched. Slower models can take well over
ten minutes; the default timeout is 30 minutes. `/waicc-dispatch --via pi --implement`
was also verified from a real Pi coordinator: DeepSeek Flash implemented the accepted
task inside its allowed path in under a minute, and the coordinator accepted the reply.
Isolated coding was verified live too: Codex and Claude (Sonnet) each implemented an
accepted task in their worktree, WAICC applied the single in-scope file and removed the
copy, and the coordinator accepted both replies, including in a Git repo with no commits.
Pre-approved checks were verified live: a Claude tester ran `--check "node --test
index.test.js"` through `waicc_run_check` (logged as passed), and Codex implemented a
function plus its test in a worktree, ran the same approved check inside the copy, and
WAICC applied both in-scope files.
**Antigravity (`agy`)** was verified live with agy 1.4.4 on Windows: a review handoff was
dispatched, agy read it and submitted a valid reply through WAICC's tools, with its steps shown
live and its tokens recorded. No setup is needed. agy reads MCP servers only from its own
configuration, so each run registers its own WAICC server there (`waicc-run-<time>-<id>`, pinned
to that one request like the other agents') and allows exactly WAICC's recipient tools on it
(`mcp(<server>/waicc_…)` under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`);
both are removed when the run ends, and any a crashed run left behind are removed after three
hours. Nothing else in agy's settings is changed, and if that file is not valid JSON WAICC does
not dispatch. agy's own headless permissions stay on, so it cannot edit files or run commands
(verified: a write and a command were both denied); `--sandbox` restricts its terminal too.
It reports tokens but no price. Implementation and pre-approved checks are not offered for agy
yet. Check `agy models` for exact model slugs.

### Agent profiles: choose an agent per role once

Instead of typing `--via` and `--model` on every dispatch, name your agents once and give
each role a default. A plain `/waicc-dispatch` then picks the agent from the waiting
handoff's role:

```text
/waicc-dispatch                    # planning handoff → your planning profile
/waicc-dispatch                    # review handoff   → your review profile
/waicc-dispatch --implement        # coding still needs --implement every time
/waicc-dispatch deepseek           # use another profile once
/waicc-dispatch --effort high      # or override one setting once (also --model)
/waicc-dispatch --profiles         # show what each role resolves to
```

#### Which agent for which role

These are suggestions from WAICC's own live runs on a small project; your results will
vary with project size, models and pricing.

| Role             | Suggested agent | Why |
| ---------------- | --------------- | --- |
| `planning`       | Claude (Opus for large work, Sonnet otherwise) | Fast and produced a valid plan after one correction (Sonnet: 82 s, about $0.27); a strong model pays off where the plan is decided |
| `review`         | A **different model family** from whoever coded: Codex if Claude or Pi coded, Claude if Codex coded | An independent reviewer catches different mistakes than the author |
| `implementation` | Codex | Codes in an isolated worktree with an OS sandbox, can run its own commands and pre-approved checks (about 2 minutes per small task) |
|                  | Pi with a fast model (for example DeepSeek Flash) | Cheap and quick for small in-place changes (53 s), edits confined to task paths, no shell |
|                  | Claude | Good for small changes in a worktree; it has no shell, so give it `--check` commands |
| `testing`        | Claude (Sonnet or Haiku) with `checks` | The tester mainly runs approved checks and reads their output (Sonnet: 52 s, about $0.19) |
| `advisor`        | Sonnet, or a cheaper model through Pi (for example DeepSeek) | Focused questions rarely need the strongest model; the main agent also asks it when stuck |

Model names change. Claude accepts aliases (`opus`, `sonnet`, `haiku`, always the latest)
or exact IDs such as `claude-opus-5-5`; Codex lists its models and their effort levels in
`~/.codex/models_cache.json` (for example `gpt-6.1-sol`); Pi lists with `pi --list-models`;
Antigravity with `agy models`.

#### Set it up

The quickest start is the default template that ships in
[`templates/waicc-agents.json`](templates/waicc-agents.json). It has ten profiles, five of
them the role defaults: Opus 5.5 at medium effort for planning, Codex `gpt-6.1-sol` at medium for review, Codex (its default model) at high
for coding, DeepSeek through Pi at medium thinking for testing and Sonnet at medium for
advice. Copy it to your user file with:

```text
/waicc-dispatch --init-profiles        # CLI: waicc profiles init
```

It creates the file only if you have none and never replaces an existing one. The
template's models need matching accounts (Claude, Codex, and DeepSeek signed in to Pi):
change any you do not have, then check with `/waicc-dispatch --profiles`. WAICC does not
create the file on its own; when no profile exists, dispatch tells you to run this.

On a new computer: install Pi and WAICC, sign in to Claude Code, Codex and Pi's DeepSeek,
then run `/waicc-dispatch --init-profiles` once. To carry your own later changes (policies,
`autoDecide`, other models) to another computer, copy your `~/.pi/agent/waicc-agents.json`.

There is no limit on profiles: roles are fixed, but you can define any number of extra
profiles and pick one by name for a single dispatch. Besides the five role defaults, the
template includes variants of the same models:

| Profile | Agent and model | Effort | When to pick it |
| ------- | --------------- | ------ | --------------- |
| `opus-max` | Claude `claude-opus-5-5` | max | Hard planning problems |
| `haiku` | Claude `haiku` | low | Quick, cheap questions |
| `sol-ultra` | Codex `gpt-6.1-sol` | ultra, 90-minute limit | Deep review of risky code |
| `luna` | Codex `gpt-6-luna` | high | Coding with a fixed model instead of Codex's default |
| `flash` | Pi `deepseek/deepseek-flash` | low | Fast, cheap checks or advice |

```text
/waicc-dispatch opus-max        # this planning handoff, with more thinking
/waicc-dispatch sol-ultra       # this review, deeper
```

To write it yourself, create either file, or both:

| File | Scope |
| ---- | ----- |
| `~/.pi/agent/waicc-agents.json` (or `$PI_CODING_AGENT_DIR/waicc-agents.json`) | Just you, every project |
| `<project>/.pi/waicc-agents.json` | Everyone using the repository; wins over the user file for any profile or role both name |

```json
{
  "profiles": {
    "opus":     { "via": "claude", "model": "claude-opus-5-5", "effort": "medium", "fallback": "codex" },
    "sonnet":   { "via": "claude", "model": "sonnet" },
    "codex":    { "via": "codex",  "model": "gpt-6.1-sol", "effort": "medium", "timeoutMinutes": 45 },
    "deepseek": { "via": "pi",     "model": "deepseek/deepseek-v4-pro", "effort": "high" }
  },
  "roles": {
    "planning":       "opus",
    "review":         { "profile": "codex", "checks": ["npm test"] },
    "implementation": "codex",
    "advisor":        "deepseek",
    "testing":        { "profile": "sonnet", "checks": ["npm test", "npm run lint"], "checkTimeoutMinutes": 10 }
  }
}
```

- A **profile** has `via` (`claude`, `codex`, `pi` or `agy`), and optionally `model`,
  `effort`, `timeoutMinutes` (1–120) and `fallback`. A **role** is `planning`, `review`, `advisor`,
  `implementation` or `testing`, set to a profile name or to `{ profile, checks,
  checkTimeoutMinutes }`.
- **`fallback`** names the profile that takes over when this one cannot work: it hit its
  usage or rate limit, is not signed in, or is not installed. In Pi, a dispatch that ends
  without a reply for one of those reasons is retried once, the same handoff with the
  fallback's agent, model and effort, and the chat says so. In a `--loop` or `--auto` run,
  the fallback is used for the rest of the run. Any other failure (a crash, a timeout, a
  rejected reply, `--stop`) is not retried, nor is a fallback that is limited too. A coding
  run that had already changed files in place is not retried on top of them. Each run's
  `result.json` records its `limit`, and the retry its `fallbackFrom`.
- **`effort`** is passed as each agent's own reasoning setting, checked against that agent's
  levels before anything runs. A model may support fewer levels than its agent (Codex
  lists each model's levels in its models cache). Omit it to use the agent's default.

  | `via`    | Becomes                          | Levels |
  | -------- | -------------------------------- | ------ |
  | `claude` | `--effort <level>`               | low, medium, high, xhigh, max |
  | `codex`  | `-c model_reasoning_effort=…`    | minimal, low, medium, high, xhigh, max, ultra |
  | `pi`     | `--thinking <level>`             | off, minimal, low, medium, high, xhigh, max |
  | `agy`    | `--effort <level>`               | low, medium, high, xhigh, max |

- Typed options win: a profile name you type replaces the role's profile, and `--via`,
  `--model`, `--effort`, `--timeout` or `--check` replace that setting. A role's `checks` apply whichever
  profile runs it, unless you type `--check`.
- Unknown fields, agents, roles or undefined profiles are reported with the file and field.
  `/waicc-dispatch --profiles` (CLI: `waicc profiles`) shows both files, every profile and
  what each role resolves to.

Safety rules:

- **`"policies"`** and **`"autoDecide": "low-risk"`** (user file only) answer routine
  decisions for you; see [Fewer decisions to answer](#fewer-decisions-to-answer-standing-policies-and-low-risk-auto-accept).
- **`"autoContinue": true`** (user file only) runs the continue step after every dispatch
  that returns a valid reply; a project file that sets it is rejected.
- **`"budget": { "perSessionUsd": 5 }`** (user file only) stops automatic runs once a
  session's agents have reported that much: a `--loop` does not start its next cycle and
  `--auto` does not start its review. You can always dispatch the next step yourself. Only
  reported dollars count, so Codex's token-only runs do not. The tracker shows each
  session's spend against it.
- **`"alerts": { "quietMinutes": 10, "desktop": false }`** (user file only; these are the
  defaults). When a dispatched agent shows no new step for `quietMinutes` (0 turns this
  off, at most 240), Pi says so once, the dispatch panel shows "no new step for 12m", and
  the tracker turns its card amber and lists it under Needs you. Nothing is stopped: a long
  build or test run also shows no step until it ends; `/waicc-dispatch --stop` ends it and
  `/waicc-dispatch` starts it again. With `"desktop": true`, each new Needs you item (a
  review passed, a plan ready, a reply to assess, a decision, a quiet agent) raises a
  desktop notification: a Windows toast, macOS Notification Center, or `notify-send` on
  Linux. They come from the tracker's updates, so they need the tracker on; one item is
  notified once, even with several chats open in the project.
- **`"autoAdvisor"`** (user file only) caps how often the main agent may ask the advisor
  on its own: 3 per chat by default, `{ "maxPerChat": n }` (0–20), or `false` for off; see
  [When the main agent is stuck](#when-the-main-agent-is-stuck-it-asks-the-advisor).
- **`"memory": { "autoApprove": true }`** (user file only) lets WAICC's corroboration rule
  confirm memory candidates; see [Let WAICC confirm what keeps being backed up](#let-waicc-confirm-what-keeps-being-backed-up-opt-in).
- **A config can never authorize coding.** There is no `implement` field; type
  `--implement` on each coding dispatch.
- **Checks from the project file are confirmed before they run.** Anyone who can change
  the repository can edit that file, so Pi lists the exact commands and asks first, and
  refuses without interactive UI. The CLI needs `--confirm-checks`. Checks in your user
  file, or typed with `--check`, need no extra confirmation.
- **The project file is project source,** so create or commit it before a handoff is
  issued. Changing it while a handoff waits changes the source fingerprint, and dispatch
  then asks for a fresh handoff.

### MCP server for any agent

`waicc mcp` is a dependency-free MCP stdio server for recipients. Any MCP client
(Claude Code, Codex, Cursor, Gemini CLI, VS Code, …) can then receive a handoff and
submit a validated reply instead of hand-writing `reply.json`. Every local STARTER
prompt mentions these tools, so the same copy/paste handoff works with or without them.

**Nothing to install.** The server has no dependencies and runs on the Node.js that WAICC
already requires. `/waicc-dispatch` needs no setup at all: it starts its own pinned server
for each run. Register the server only to use these tools when you paste a STARTER prompt
into an agent yourself; once per agent, for all projects:

```sh
claude mcp add --scope user waicc -- waicc mcp     # Claude Code
codex mcp add waicc -- waicc mcp                   # Codex
```

`waicc` is on your PATH only for an npm install. After `pi install git:…`, point at Pi's
copy of the package instead (`pi list` shows where it is), for example:

```sh
# Windows
claude mcp add --scope user waicc -- node C:\Users\<you>\.pi\agent\git\github.com\whatley95\pi-waicc\src\cli.ts mcp
codex mcp add waicc -- node C:\Users\<you>\.pi\agent\git\github.com\whatley95\pi-waicc\src\cli.ts mcp
# macOS / Linux
claude mcp add --scope user waicc -- node ~/.pi/agent/git/github.com/whatley95/pi-waicc/src/cli.ts mcp
codex mcp add waicc -- node ~/.pi/agent/git/github.com/whatley95/pi-waicc/src/cli.ts mcp
```

A registered server finds the WAICC project from the directory it is started in, so start
the agent from inside your project (verified with Claude Code and Codex on Windows). If `waicc_receive` reports `Unknown WAICC session`,
the server started elsewhere: start the agent in the project, or add `--root
<project>` before `mcp` when registering it for a single project. After `pi update`, the
registered path picks up the new version automatically.

| Tool                   | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `waicc_receive`        | Pin the session's single waiting request (session and request IDs required) |
| `waicc_assignment`     | Re-read the pinned contract, requirements, context, history and inputs  |
| `waicc_read_input`     | Read one listed input file in chunks, for agents working outside the project |
| `waicc_run_check`      | Run one check the human pre-approved at dispatch, by number; logged in the round |
| `waicc_validate_reply` | Dry run of every submit-time check; writes nothing                      |
| `waicc_submit_reply`   | Validate and write the one reply; does not assess or advance the contract |

The server never retargets to another request and refuses implementation assignments.
It adds tools to an agent but cannot remove the agent's own edit or shell tools: run
reviewers read-only (for example Claude's `--permission-mode plan` or Codex's
`--sandbox read-only`). `waicc mcp --session <id> --request <id>` pins the server to one
request, which is how dispatch starts it. Dispatch adds `--implement` only for an agent
coding in an isolated worktree, whose changes WAICC checks before applying them.

## Contracts for complicated work

The master contract preserves the overall requirements. Task contracts inside it
describe smaller outcomes, their dependencies, permitted source paths and acceptance
criteria. For example, agree the API/data behavior before backend and frontend
implementation, then verify their integration against the original requirements.

Requirements have stable IDs and exact quotes from the original request or an
amendment. Acceptance criteria link back to those IDs and distinguish planned
verification from actual results. Dependency cycles, unknown references and unsafe
paths are rejected.

Every handoff identifies the role, pinned inputs, permitted changes, expected
deliverables, response format and stopping conditions. It also includes recent
replies, findings, assessment decisions and check evidence. Changed requirements or
source invalidate affected replies instead of silently accepting stale work.

Other agents can raise concerns without matching every finding field name exactly.
WAICC accepts `title`/`message` as `description`, generates missing finding IDs,
normalizes severity casing and accepts evidence text arrays. Extra annotations such
as file/line/recommendation stay visible under `extensions`. The original reply is
preserved, while the coordinator receives a canonical view and conversion log.
Required evidence/severity, pinned identity, coverage and freshness remain checked;
normalization does not adopt suggestions or certify their claims. See
[flexible finding intake](docs/PROTOCOL.md#flexible-finding-intake).

Reply intake also tolerates equivalent check formats: `pass`/`success` → `passed`,
`fail`/`failure` → `failed`, and `not run`/`not-run`/`skipped` → `not_run`.
Checks can use `status` or `result` for `outcome`, `name`/`check`/`command` for a
missing description, and `details`/`output` for missing evidence. Conflicting
outcomes are rejected; additional check annotations are preserved as untrusted
`extensions`, never executed. Check/coverage evidence arrays are joined as text;
single-text proposed decision evidence becomes a one-item array. Casing and
separators may be normalized only when they match the same canonical meaning.

This lets `/waicc-continue` read common external-agent JSON variants without
rewriting the original reply. It does not accept arbitrary prose, infer missing
facts, turn top-level `PASS` into readiness, or promote unverified coverage.
Unknown check results identify `checks[index].outcome` and the expected values.

WAICC records these dependencies and conversations. It does not automatically
schedule parallel implementations or certify that dependent tasks are complete.

## What v0.1.0 does

- Generates versioned JSON contracts and readable Markdown from the same data.
- Produces starter prompts, detailed handoffs and matching reply templates.
- Supports focused contract-advisor questions without implying planning readiness.
- Receives a pinned handoff in a manually opened Pi chat, using its current model.
- Dispatches handoffs to headless Claude Code, Codex or Pi with a chosen model: read-only
  roles, coding (Pi in place, Claude/Codex in an isolated worktree) and testing with
  pre-approved check commands.
- Serves recipient tools to any MCP client with `waicc mcp`, validating replies before writing.
- Validates and freezes replies before Pi assesses them.
- Preserves original requirements, amendments, contract history and decisions.
- Detects stale source, incomplete coverage and changes outside implementation scope.
- Bundles WAI skills and supports source-linked, human-confirmed project memory.
- Exports portable handoffs and recovers committed state after interrupted writes.

External agents run when you submit their prompts, or when you explicitly dispatch a
read-only handoff with `/waicc-dispatch` (Claude Code, Codex, Pi, experimental
Antigravity). Preparation and assessment use your existing Pi agent and configured
model. This release does not automatically implement code, commit, push or deploy.
Explicitly opted-in Pi implementation recipients can edit only their assigned paths.

Planning, review and advisor handoffs instruct agents to inspect source and write only their
designated reply. Their actual permissions remain the responsibility of the invoking
environment; prompt instructions are not an OS sandbox. A ready contract or passing
model assessment is not proof of tested delivery.

## Commands

| Command                                          | Purpose                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `/waicc-planning <requirements>`                 | Start a new durable task/session and ask Pi to prepare its contract                                   |
| `/waicc-auto-planning [on\|off]`                  | Plan when tracked steps help, even for small work; default on. Legacy complex aliases on |
| `/waicc-develop [--main\|--delegate]`             | Explicitly accept/authorize the current plan in this session; no handoff or round consumed |
| `/waicc-decisions [session-id]`                 | Show the consolidated gate brief, recommendations, evidence and affected tasks |
| `/waicc-decide <decision-id> <answer>`           | Record an existing gate's human answer in a versioned audit; not a scope amendment |
| `/waicc-decide auto`                             | Run your low-risk auto-accept now and see why each remaining decision still needs you |
| `/waicc-decide`                                  | Pick an open decision from a list, then accept its recommendation or type your own |
| `/waicc-decide <decision-id>\|all recommended`    | Accept the agent's recommendation as your answer, for one decision or all of them |
| `/waicc-planning --delegate <requirements>`      | Plan with the main agent as coordinator and delegated implementation/fix cycles |
| `/waicc-help-develop [focus]`                      | Delegate the entire accepted implementation or ALL review fixes |
| `/waicc-implement [focus]`                       | Compatibility alias for `/waicc-help-develop`, including `--main` |
| `/waicc-test [focus]`                           | Optional whole-work testing handoff; no application/test source edits |
| `/waicc-help-develop --main [focus]`              | Return coding to the main contract owner; no handoff |
| `/waicc-test --main [focus]`                   | Return testing to the main contract owner; no handoff |
| `/waicc-review <focus>`                          | Prepare ONE full code-change review after ALL work/fixes/checks; without a selection, capture supplied review requirements |
| `/waicc-review --rev <commit\|a..b\|a...b\|r1234[:r1250]> [focus]` | Review an existing Git or SVN change in its own session; the reviewer gets its patch and commit messages |
| `/waicc-review --mr <n> [--remote r] [--into branch] [focus]` | Review a GitLab merge request or GitHub pull request, fetched with plain git; again later to pick up new commits |
| `/waicc-review --mr --list [--remote r]`         | Pick a merge request to review from a list (open ones with titles when your GitLab host is set up) |
| `/waicc-mr-comments`                             | Post the assessed merge request review to GitLab: line comments and a summary, after you choose and confirm |
| `/waicc-review --contract <focus>`               | Explicit specification-only review, not code-change approval |
| `/waicc-advisor [--requirements IDs] <question>` | Ask for focused advice on the saved contract; no automatic revision or readiness                      |
| `/waicc-continue`                                | Import/validate the waiting reply, assess it, or resume an unfinished draft                           |
| `/waicc-compact [additional notes]`              | Validate recovery evidence and ask Pi to compact chat; optional owner notes require no pending handoff |
| `/waicc-handoff [session-id]`                    | Show a copy-only manual recipient prompt, access requirements and separate human return steps         |
| `/waicc-receive <session-id> [--implement] [--run-checks]` | Receive a pinned role; edits opt in separately from individually confirmed local checks |
| `/waicc-dispatch --via claude\|codex\|pi\|agy [--model m] [--timeout min]` | Run the waiting read-only handoff in a headless agent; you are notified when it finishes |
| `/waicc-dispatch --via pi\|claude\|codex --implement [--model m]` | Run a delegated implementation: Pi in place within task paths; Claude/Codex in an isolated worktree, applied all or nothing |
| `/waicc-dispatch --via <agent> --check "<command>"...` | Dispatch a testing (or coding) handoff that may run only these exact pre-approved commands |
| `/waicc-dispatch [profile]`                      | Dispatch with the agent profile for the waiting handoff's role, or a named profile |
| `/waicc-dispatch --progress`                     | List every step the running agent has taken so far |
| `/waicc-tracker [on\|off]`                       | Open the live page for all your projects in the browser; off/on stops or resumes its updates |
| `/waicc-dispatch [profile] --continue` (or `-c`)  | Run the continue step automatically when a valid reply arrives (`--no-continue` to skip once) |
| `/waicc-dispatch [profile] --loop [cycles]`      | Code review → fix → re-review until it passes, or plan → assess → revise until accepted; at most 3 cycles by default; never closes |
| `/waicc-dispatch --loop 3 --develop [--review]`  | Plan until accepted, start development, then review with your review profile until it passes |
| `/waicc-dispatch --auto [--plan-with p] [--review-with p]` | Short for `--loop 3 --develop --review`, choosing each stage's profile |
| `/waicc-dispatch --auto --code-with [p]`         | Another agent codes the accepted plan and fixes the review's findings; the main agent only assesses |
| `/waicc-dispatch --auto --review-once`           | Stop after the first code review, without fixing                                                       |
| `/waicc-dispatch --profiles`                     | Show both agent config files, every profile and what each role resolves to |
| `/waicc-dispatch --init-profiles`                | Create your user agent config from the default template; never replaces an existing file |
| `/waicc-dispatch --stop`                         | Stop the agent dispatched from this chat; the handoff stays waiting                                   |
| `/waicc-status [open\|all\|closed\|deleted\|session-id]` | Show selected progress or an explicit session-list view                                          |
| `/waicc-list [open\|all\|closed\|deleted]`      | List open sessions by default; explicitly include closed sessions or inspect recovery storage           |
| `/waicc-delete <session-id>`                    | Move one CLOSED session to project-local recovery storage; no source or shared-memory deletion           |
| `/waicc-restore <session-id>`                   | Restore a deleted session as CLOSED, preserving history without selecting or reopening it               |
| `/waicc-use <session-id>`                        | Select coordinator mode for an existing project session; explicitly leaves recipient mode             |
| `/waicc-close [session-id] <reason>`             | Close fresh code-review READY_TO_CLOSE, or planning-only SPEC_APPROVED |
| `/waicc-close [session-id] --force [reason]`     | Stop the contract immediately, cancel pending handoffs and preserve history; no review PASS             |
| `/waicc-force-close [session-id] [reason]`       | Shortcut for force-close; ID alone works, or omit it for the selected session                           |
| `/waicc-reopen <reason>`                         | Reopen a closed contract; clears PASS and requires a fresh review                                     |
| `/waicc-amend <requirement change>`              | Append original-scope amendments and invalidate pending requests                                      |
| `/waicc-cancel [session-id] [reason]`            | Cancel a pending handoff by ID or in the selected session; reason optional, history preserved           |
| `/waicc-export`                                  | Package the pending handoff, requirements, contract and selected skill references                     |
| `/waicc-limit [phase] <2–20>`                   | Explicitly change one phase budget or the overall cap; no resets |
| `/waicc-memory [query]`                          | Inspect candidate/active/stale memory                                                                 |
| `/waicc-memory confirm\|revoke [<id>\|all]`       | Human curation: a specific entry, all candidates after one dialog, or pick from a list with no ID |
| `/waicc-memory audit`                            | Replay the corroboration rule against what you confirmed and revoked                             |
| `/waicc-ignore`                                  | Configure SVN ignore rules explicitly; Git is automatic                                               |
| `/waicc-init`                                    | Make the current folder its own WAICC project, such as one service in a monorepo |
| `/waicc-worktree <branch> [--from b] [--path p]` | One folder per branch (git worktree): create it, beside the repository |
| `/waicc-worktree [list]` | List the branch folders: branch, open sessions, changes, unpushed commits |
| `/waicc-worktree remove <branch>` | Remove a branch's folder safely; the branch is kept |

Bindings are per Pi chat and repository, persisted in Pi's session entries. Multiple
sessions are never silently resolved by choosing the newest. `/waicc-use` provides
explicit recovery if Pi's history is unavailable.

To cancel, use `/waicc-cancel <session-id>` directly in a coordinator chat—no
`/waicc-use` or `/waicc-receive` needed. If a session is already selected, just
`/waicc-cancel` works. A reason is optional and defaults to `Cancelled by user.`;
`/waicc-cancel <reason>` still cancels the selected session's pending handoff.
An explicit ID does not change this chat's selected session. Cancellation marks
the pending round CANCELLED and the session NEEDS_CHANGES; it does not delete or
close the contract, stop an external process, or automatically inherit context into
a new session. Start a fresh contract with `/waicc-planning <requirements>` and
explicitly reference the old session if its history should be used as context.
Recipient chats still require `/waicc-use <session-id>` to leave recipient mode
before coordinator actions such as cancellation.

`/waicc-list` hides CLOSED sessions, regardless of the chat's selection. Use
`/waicc-list all` to include them or `/waicc-list closed` to see only closed sessions.
`/waicc-status` without a selection also defaults to the open-session list; with a
selection it still shows that session's details, including a closed one.

`/waicc-status all` (equivalent to `/waicc-list all`) lists each retained session's ID, status, `createdAt` and `updatedAt`,
plus `contractReview` and `deliveryVerified`, sorted by most recent activity first.
Both timestamps also appear in single-session
status. Times are UTC: creation stays fixed; update time is the latest committed
session event (including handoffs, reply intake, assessments, amendments, exports
and round-limit changes). Reading status or waiting for a reply does not update it;
neither do unrelated file edits or writing an external reply before intake. Older
sessions recover their update time from the existing journal without migration.

### Remove a closed session

```text
/waicc-delete <session-id>
```

This requires an explicit ID and a CLOSED session; it never closes or deletes open
work automatically. The entire session directory moves from
`.pi/pi-waicc/sessions/<id>` to `.pi/pi-waicc/deleted-sessions/<id>`. It disappears
even from `/waicc-list all`, but remains recoverable:

```text
/waicc-list deleted
/waicc-restore <session-id>
```

Restoration returns the original history and verdict, still CLOSED, without
reopening or selecting the session. Neither operation rewrites journals or changes
their activity timestamps. They leave project source, other sessions and shared
project memory unchanged. This is recoverable deletion, not permanent erasure or
the operating system's recycle bin; no automatic purge is performed.

Delete/restore are human coordinator commands, not agent tools. Deleting the current
selection clears that chat's saved selection. Other chats pointing to the deleted
session report it unavailable without selecting another session. CLI equivalents:
`waicc list [open|all|closed|deleted]`, `waicc delete <id>`, `waicc restore <id>`.

## Finish a contract discussion

`READY_TO_CLOSE` means **whole-change code review passed; waiting for your final decision**
for development. New specification-only work uses `SPEC_APPROVED`, not code approval.
Legacy specification histories can retain the old closure-ready label, explicitly
identified as specification-only in status; `/waicc-develop` continues the same session.
`CLOSED` means **you explicitly finished the contract discussion**. Review agents
recommend readiness; only an assessed full-contract review can record PASS. No
assessment closes the contract automatically.

To stop an unfinished contract immediately, use:

```text
/waicc-force-close <session-id>
```

Or just `/waicc-force-close` for the selected session. No separate cancel,
receive, review or reason is required; append a reason only if useful.
This also works as a human stop command in a recipient chat, without granting the
recipient coordinator tools or changing its binding. It records `status: CLOSED`,
`closure.kind: forced`, `contractReview: NOT_REVIEWED`, and `deliveryVerified: false`.
Pending handoffs are CANCELLED and history is retained. This is termination, not
contract acceptance or a claim of successful review. It does not kill external
agent processes. Repeating force-close on an already closed contract is a no-op;
an existing reviewed closure is not downgraded. `/waicc-close [session-id] --force [reason]`
is an equivalent form. CLI: `waicc close <session-id> --force [reason]`.

To accept a successfully reviewed contract, use normal closure instead:

```text
/waicc-close Whole-change code review passed; accepted
```

The resulting status includes:

```json
{
  "status": "CLOSED",
  "contractReview": "PASS",
  "deliveryVerified": false
}
```

For contract-only work, planning completion is `planned` -> `PLAN_READY`,
with no implementation handoff. Then `/waicc-review --contract Check full-contract requirements, dependencies, acceptance criteria and planned verification`.
If a legacy implementation handoff is already pending, first explicitly
`/waicc-cancel Pause implementation for contract-only review`.
Send that handoff to a reviewer. When its reply is ready, `/waicc-continue` starts
assessment; planning-only work may close after `SPEC_APPROVED` (legacy records can
retain `READY_TO_CLOSE`). To build instead, use `/waicc-develop`; no new contract is needed.

Normal, reviewed closure requires the latest passing review to match the current contract,
requirements and source, with no reply pending. A changed source makes status show
`STALE` instead, without rewriting history or update time. A revised contract must
be reviewed in a new round; task-only reviews, planning readiness and advice cannot
close the whole contract. `/waicc-review` targets all finished implementation against
the saved version, with a whole-work completion report, without silently revising it.

A specification-only reviewed/closed contract may retain future human/external gates;
whole-work code review requires all execution decisions resolved and every task complete.
PASS/CLOSED does not answer those choices or authorize gated tasks. Legacy planning
`ready` still creates an implementation handoff but requires every execution decision
resolved; use `planned` to accept a plan without an external implementation handoff. Gate lists are informational,
not a scheduler or evidence that task dependencies have been completed.

Closed sessions remain selectable and readable, but their mutations are blocked.
To reconsider one:

```text
/waicc-reopen Reconsider pagination requirements
```

Reopening records the reason and resets it to `NEEDS_REVIEW` with
`contractReview: NOT_REVIEWED`. Revise or amend as needed, then obtain a fresh review
before closing again. Closure/reopening history is retained. Closing, reopening
and a review PASS never set `deliveryVerified` (or legacy `verified`) to true.
These commands are explicit user actions, not agent tools; they are not an OS-level
permission boundary against an agent with shell/filesystem access.

The CLI equivalents are `close <session-id> <reason>` and `reopen <session-id> <reason>`
with `--root <project>`. Older `READY_FOR_HANDOFF` records are preserved, not silently
upgraded to PASS; request a fresh review to use closure.

## When the main agent is stuck: it asks the advisor

While it works, with or without a WAICC session, the main agent can ask your advisor (the
`advisor` role's profile, Sonnet in the default template) for a second opinion by itself.
It does this when it is genuinely stuck: the same check still fails after two real fix
attempts, it cannot find a bug's cause, or it must choose between risky designs it cannot
settle from the code. You can also just tell it "ask the advisor".

- The advisor reads the project **read-only**: Claude gets only Read/Grep/Glob, Codex runs
  in its read-only sandbox, Pi gets only read/grep/find/ls. It gets the question, what was
  already tried, the exact errors and the files to start from, then answers with a
  diagnosis (with file:line evidence), a recommended next step, a fallback and how to
  confirm.
- **The answer is advice, not an instruction.** The main agent verifies it against the code
  before acting. It creates no handoff and changes no contract, decision or authorization.
- You see each question: a notice, a live panel while the advisor works, and the tool
  call with its answer in the chat. The brief and answer are kept in
  `.pi/pi-waicc/consults/`.
- **At most 3 questions per Pi chat by default.** Change it in your user file. A project
  file cannot set this.

```json
{ "autoAdvisor": { "maxPerChat": 5 } }
```

Use `"autoAdvisor": false` to turn it off.

This is separate from `/waicc-advisor` below, which asks a formal question about the
saved contract and goes through a handoff.

## Ask a contract advisor

Use an advisor for a focused decision on an **existing saved contract**, such as
architecture, a risky assumption, or choosing between approaches:

```text
/waicc-advisor Should we use cursor or offset pagination for this contract?
```

Optionally select requirement IDs for the advice's coverage rows:

```text
/waicc-advisor --requirements REQ-001,REQ-002 Compare the authorization approaches and their trade-offs.
```

Without selected IDs, it answers the question only (`coverage: []`); it does not
claim whole-contract coverage. The advisor reads the contract, relevant source,
selected skills, recent discussion and a snapshot of relevant confirmed memory.
It returns options with benefits, trade-offs and evidence, a recommendation,
assumptions, and suggested amendments. Completed advice compares at least two
options; insufficient information should produce questions or a blocker instead.

Send the generated `STARTER.txt` to your chosen agent. After its `reply.json` is
ready, run `/waicc-continue`. Pi checks the advice and records `noted` →
`ADVICE_READY`, asks a focused follow-up, or records the blocker. **Advice never
adopts amendments, changes the contract, confirms memory, marks the plan ready,
or generates an implementation handoff.** Findings and unverified coverage remain
visible even when advice is noted. Tell Pi which recommendation you accept before
it explicitly prepares a revised planning/review contract. New scope still needs
`/waicc-amend`; for whole-contract verification use `/waicc-review`.

Only one request can be pending per session. Finish it first, or explicitly pause
it with `/waicc-cancel Pause planning to obtain focused advice` before asking the
advisor. The advisor command itself needs no model call and creates no new contract
version. It uses the same reply identity, freshness checks, history, export and
round limits as other handoffs.

Standalone CLI equivalent:

```sh
node src/cli.ts --root <project> advisor <session-id> --requirements REQ-001 "Which pagination approach fits?"
```

## Monorepos: one service as its own project

WAICC's project is normally the repository root. A Git repository of more than 10,000 files
(a whole monorepo) is fingerprinted with Git's own blob IDs instead of reading every file, up to
100,000 files, so reviewing a merge request across services from the root works. For day-to-day
work on one service the root can still be too much: every commit by any team would look like a
change to your handoffs. Make the service folder its own project, once:

```text
cd services/status
/waicc-init          # CLI: waicc init
```

From then on, Pi started in that folder (or below it) treats it as the WAICC project:

- **Only that folder is fingerprinted**, through Git, as its own subtree. Commits elsewhere in
  the monorepo do not change its fingerprint, so they never invalidate its handoffs.
- **Its state lives in its own `.pi/pi-waicc/`**, which ignores itself, so the monorepo shows
  no new files. Sessions you already had at the repository root stay there.
- **Allowed paths, checks and memory sources are relative to the service folder.**
- **Isolated coding (Claude/Codex) gets the whole monorepo as context:** the rest of the
  repository as last committed, plus the service's current files exactly. Shared modules
  still build, but only changes inside the service can be applied; a change to another
  service is reported as outside the task's allowed paths, and nothing is applied.

Work that spans services, such as changing a producer in another service, belongs in that
service's own session (run `/waicc-init` there too), or in a shared parent folder initialized
the same way if one contract must cover both and it stays under the file limit.

### Several branches at once: one folder per branch

In a monorepo, switching branch switches every service at once. Instead, give each branch its
own folder with `/waicc-worktree`; they share one repository (no second clone), and each folder
keeps its own WAICC sessions and tracker card, so switching work means switching terminal:

```text
/waicc-worktree feature/sync              # a folder for the branch, beside the repository
/waicc-worktree fix/status --from develop # a new branch, from develop
/waicc-worktree list                      # list them: branch, open sessions, changes, unpushed
/waicc-worktree remove feature/sync       # remove the folder; the branch is kept
```

The folder is `<repository folder>-<branch>`, for example `C:\dev\monorepo-feature-sync`
(`--path` chooses another). WAICC uses your local branch if there is one, otherwise the
remote's (tracking it), otherwise it creates the branch from `--from` or the remote's default
branch. If you run it from a service set up with `/waicc-init`, that service is set up the same
way in the new folder, and Pi starts there; on Windows it offers to open a new terminal there
with Pi running. Removing refuses a folder with uncommitted changes, and asks first when it has
unpushed commits or open WAICC sessions, which live in that folder. It never removes the main
folder, the folder this chat works in, or WAICC's own temporary folders for delegated coding.
Git does not check out one branch in two folders, so each branch has at most one.

## Project storage and version control

```text
myproject/
  .pi/pi-waicc/
    .gitignore
    write.lock                    # Present only during a mutation
    memory/entries.json
    sessions/<session-id>/
      requirements.md             # Original request, never rewritten
      amendments/<number>.md
      session.json                # Disposable display cache
      journal/<sequence>-<id>.json # Immutable authoritative transactions
      snapshots/<digest>.json     # Each source file-hash snapshot, stored once
      checkpoints/<checkpoint-id>/
        CHECKPOINT.md             # Bounded recovery brief, not proof of completion
        checkpoint.json           # Canonical ID/path/evidence index
      contracts/v001/
        contract.json
        CONTRACT.md
      rounds/<request-id>/
        request.json
        HANDOFF.md
        STARTER.txt
        reply.example.json
        CHECKPOINT.md             # Frozen issue-time brief for this exact request
        checkpoint.json           # Frozen original-evidence index
        conversation.json         # Complete saved round history, available on demand
        memory.json               # All new roles: confirmed memory at issue
        skills/                   # Only guidance selected for this handoff
        reply.json                # Written by the external agent
        received.json             # Frozen original response after validation
        received.normalized.json  # Canonical view, only when conversion occurred
        reply-normalization.json  # Versioned conversion log, when applicable
        assessment.json
      exports/<export-id>/
      lifecycle/<closure-id>/
        closure.json              # Reviewed PASS or explicit forced closure, reason and time
        CLOSURE.md
        reopen.json               # Present if this closure was reopened
    deleted-sessions/<session-id>/ # Recoverably deleted CLOSED session, complete original tree
```

Git ignores generated state using a `.gitignore` inside `.pi/pi-waicc`; no root
ignore-file changes are needed. Already-tracked files remain tracked: remove them
from tracking yourself before relying on an ignore rule.

For SVN, run `/waicc-ignore` before preparing the first handoff. Existing ignore
rules are preserved. If `.pi` is versioned, `pi-waicc` is ignored there; otherwise
`.pi` is ignored at the working-copy root. This is an explicit SVN property change
that you can inspect with `svn diff`. It does not schedule files for addition.

Exports contain the requirements, contract, shared saved context, complete saved round
conversation, selected skills, confirmed-memory snapshot and recorded check evidence;
they do not copy the source checkout or authentication files. The recipient needs
matching source separately. Exported paths are portable; return the resulting
`reply.json` to the original round's designated location. `manifest.json` identifies
its inputs. Review project content before sharing an export.

## Memory and WAI skills

The model can recall confirmed knowledge and propose facts, decisions or lessons
through `waicc_memory`. Each entry pins a project-relative evidence file and digest.
Candidates do not enter automatic recall until they are confirmed: by you, or by the
opt-in corroboration rule below. Changed or
missing evidence makes an entry stale; reading or repeating it never renews it.
File existence is not semantic verification. Keep speculative fixes and unfinished
work in the session, not durable memory.

Confirming is a human step by default: a confirmed entry goes into every future
handoff in the project, for every agent, so a wrong agent conclusion would quietly
mislead all later work. You can let WAICC confirm what independent work keeps backing up
(below). Confirming yourself is quick:

```text
/waicc-memory                  # review candidates: text, kind and source file
/waicc-memory confirm          # pick one from a list (or "All")
/waicc-memory confirm all      # one dialog listing every candidate, then confirm them together
/waicc-memory confirm <id>     # a specific entry
/waicc-memory revoke           # the same choices for removing an entry
/waicc-memory audit            # what the corroboration rule would confirm, against your choices
```

A wrong or missing ID lists the candidates instead of failing. Stale candidates, whose
source file changed, are not offered: propose a fresh one from the current source.

**A fact can quote its source.** The main agent copies the exact lines a fact rests on. While
those lines are in the file, the entry stays current, even when the rest of the file changes;
line endings and trailing spaces do not count. Without a quote, any change to the file makes
the entry stale, as before.

### Let WAICC confirm what keeps being backed up (opt-in)

With `"memory": { "autoApprove": true }` in your user file (a project file cannot set it),
WAICC confirms some candidates itself. It never judges whether a claim is true; it checks
that the claim is pinned to the source and keeps being backed by independent work. No model
is called and nothing leaves your machine.

- **A decision you answered with `/waicc-decide`** is confirmed at once. The main agent asks
  for it by decision ID, and WAICC writes the entry itself: the question and your exact
  answer. Answers from a standing policy or `autoDecide` are not yours word for word, so they
  are refused.
- **A lesson from recurring review findings** is confirmed once findings from 3 sessions back
  it. When the same problem comes back in another session, the main agent adds those findings
  to the existing lesson instead of proposing a second one.
- **A fact** is confirmed at 4 points:

  | Support | Points |
  |---|---|
  | The same claim about the same file proposed in another session | +2 |
  | …by a different model than the first time | +2 |
  | A later code review passed with that file changed and the quote still there | +1 each, at most 2 |
  | Proposed a week ago, quote still there | +1 |

  A fact proposed once never reaches 4 points on its own.
- **Some things always wait for you**, however many points: a fact without a quote; a claim
  naming code (`codingAgent`, `src/profiles.ts`, `memory_rule`) that is not in its source; an
  entry that resembles one you revoked (so revoking teaches the rule); and a fact that an
  accepted review finding is about.

`/waicc-memory` shows each candidate's points, reasons and what blocks it. Entries the rule
confirmed are marked `approvedBy: waicc-rule`, are recalled like yours, and you revoke them
the same way. The rule is checked each time: if a quote disappears or a blocking finding
appears, the entry stops being recalled.

**Check it on your own history first.** `/waicc-memory audit` (CLI: `waicc memory audit`)
replays the rule over every entry beside what you did with it: how many of your confirmations
it agrees with, and whether it would have confirmed anything you revoked. It works with the
rule off.

**Lessons from mistakes that keep coming back.** When the main agent assesses a review
with findings, WAICC shows it earlier sessions' findings that look similar, ranked by
shared words. If one is genuinely the same kind of problem (for example "no test for empty
input" in an order search and again in a customer filter), the main agent proposes one
lesson for future plans with `waicc_learn_pattern`, such as "Plan a test for empty input on
every new search or filter":

- It must cite findings from **at least two sessions**. Each must be an assessed review
  finding the main agent did not dispute.
- **Each finding backs one lesson at most**, so the same pattern is never proposed twice. A
  pattern whose lesson you revoked is not proposed again.
- It is a **candidate** until you confirm it. It appears under "Needs you" on the tracker
  and in `/waicc-memory`, where its source reads "review findings: 2 in 2 sessions".
- Once confirmed, it goes into **every** future planning handoff in the project, not only
  those that share its words, so planners plan for it up front. Changing or deleting a
  finding it rests on makes it stale.

All WAI skills and their linked domain/design references are packaged. They load
on demand; external handoffs carry selected copies and do not require WAI tools.
The collection covers API contracts, debugging, delivery, dependency upgrades,
Flutter, Kotlin, learning, Node.js, refactoring, security, interface design, Spring,
testing and web development.

Automatic skill rewriting, global personal memory, background reflection/model
calls, and learning from unverified replies are intentionally absent in 0.1.0.
See [skill provenance](THIRD_PARTY_NOTICES.md).

## Integrity and limits

Some models send a nested tool argument (a contract, completion report or reply) as JSON
text instead of an object. WAICC decodes such text for every argument whose schema is not
plain text, in Pi tools and the MCP server, so these models no longer loop on
"Contract must be an object". Text that is not a JSON object or array is left unchanged and
still reported.

Contracts retain source quotes and stable requirement IDs. Dependency graphs must
be acyclic; acceptance criteria reference known requirements. Readiness requires
every requirement to have planned verification, addressed reply coverage, no open
questions or failed checks, and explicit dispositions for high/critical findings.
`verified` remains false: schema validity and model agreement do not prove tests ran.
Advisor `ADVICE_READY` is separate from readiness: it records a completed advice
exchange, not whole-contract coverage, resolution of findings, or permission to implement.

Git fingerprints include revision, index and working-tree/untracked nonignored file
content. SVN fingerprints include root revision, reported working-copy changes,
actual property values and source content, including untracked files. SVN XML
attribute order is normalized, so repeated unchanged reads keep the same fingerprint;
property values and real working-copy changes still matter. Pending SVN handoffs
from before this normalization may need a fresh request after upgrading. Common
untracked build/dependency directories and WAICC output are excluded; tracked source
is retained even under a build-named directory. Symlinks/junctions fail closed rather
than expanding scope.
Limits: 10,000 files read one by one (a Git project above that uses Git's blob IDs, up to
100,000 files), 128 MB of source content read (for such a Git project, of changed and untracked
files only), 128,000-character contracts and 256 KB replies. Per-subtree fingerprint
configuration and cross-repository scheduling are future work. There is no automatic
parallel implementation scheduler or task-completion certification in this release.

State writes use one project writer lock and atomic journal commits. A corrupt
`session.json` cache does not lose committed state. Incomplete pre-commit artifacts
can be replaced on retry; committed artifacts are checked for modification. A dead
writer's lock can be recovered with `node src/cli.ts recover-lock --root <project>`;
the command refuses a live PID or uncertain machine identity.

## Develop and inspect

```sh
git clone https://github.com/whatley95/pi-waicc.git
cd pi-waicc
npm install --ignore-scripts
npm run check
node src/cli.ts --help
```

A clone runs the TypeScript sources directly. Packed or installed copies run the
compiled `waicc` bin from `dist/` (`npm run build`, also run by `prepack`), because
Node does not strip types from files under `node_modules`.

The automated suite covers contract and dependency validation, reply identity and
freshness, crash recovery, writer locks, path boundaries, Git/SVN evidence, memory,
exports, recipient pin/resume/tool boundaries, and actual Pi 1.2.0 extension loading
and handoff-tool execution. Live-model
output quality still needs validation on real project work.

The standalone CLI can create, prepare, import, assess and export sessions without
running Pi. Run it with `--root <target-project>`; use explicit session IDs. See the
[protocol and example](docs/PROTOCOL.md) for the contract/reply/assessment formats.

See [the source repository](https://github.com/whatley95/pi-waicc) for development
and [open an issue](https://github.com/whatley95/pi-waicc/issues) for reproducible
problems. Include the Pi/Node versions and a redacted description of the affected
contract or round; project-local sessions are not uploaded automatically.

## License

[MIT](LICENSE). Bundled WAI skills and upstream design guidance retain their
[attribution and license notices](THIRD_PARTY_NOTICES.md).
