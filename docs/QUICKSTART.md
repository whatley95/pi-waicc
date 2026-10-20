# WAICC quick start

From install to a closed contract in ten commands. Every rule and option is in the
[README](../README.md); the exact formats are in [PROTOCOL.md](PROTOCOL.md).

## 1. Install (once)

You need Node.js 22.19+ and Pi.

```sh
pi install git:github.com/whatley95/pi-waicc
```

Open your project in Pi and accept its trust prompt. To update later, run
`pi update git:github.com/whatley95/pi-waicc`, then type `/reload` in each open Pi chat.

## 2. Choose your agents (once)

```text
/waicc-dispatch --init-profiles
```

This writes `~/.pi/agent/waicc-agents.json` with ready-made profiles and one profile per
role: planning (Claude Opus), review (Codex Sol), coding (Codex), testing (DeepSeek) and
the advisor (Claude Sonnet). Edit it to use the agents you have; `/waicc-dispatch --profiles`
shows what each role resolves to. You need each agent's CLI installed and signed in
(`claude`, `codex` or `pi`).

## 3. One piece of work, start to finish

Describe the outcome, not the steps:

```text
/waicc-planning Add customer search with pagination. Keep the current API response format.
```

Then:

| Step | Command | What happens |
|------|---------|--------------|
| Plan | `/waicc-dispatch` | The planning agent investigates the code and returns a plan. You are notified when it is done. |
| Check the plan | `/waicc-continue` | Pi checks the reply against your request. When it is sound, the plan is accepted: `PLAN_READY`. |
| Answer decisions | `/waicc-decide D1 recommended` | Only if the plan has choices for you; Pi tells you the exact command. |
| Build | `/waicc-develop` | The main agent codes the whole plan and runs the checks. |
| Ask for a review | `/waicc-review Check search, paging and tests` | Pi prepares one review of the whole change. |
| Review | `/waicc-dispatch` | A different model reviews the actual code. |
| Read the review | `/waicc-continue` | If it found problems, the main agent fixes them all; ask for a fresh review again. When it passes: `READY_TO_CLOSE`. |
| Close | `/waicc-close Search shipped` | You decide the work is finished. |

`/waicc-status` shows where you are and the next step at any time.

## 4. Or let it run on its own

```text
/waicc-planning Add customer search with pagination. Keep the current API response format.
/waicc-dispatch --auto
```

`--auto` plans until the plan is accepted, starts development, then reviews and fixes until
the review passes (at most 3 cycles each). It stops and tells you when something needs you:
a decision, a blocker, the same findings twice, or your budget. It never closes the contract;
you still run `/waicc-close`.

## 5. Worked example: Claude plans, Codex codes in a worktree, a third model reviews

```text
/waicc-planning --delegate Add CSV export to the orders page. Use the existing table columns.
/waicc-dispatch opus                                # Claude Opus plans
/waicc-continue                                     # Pi accepts the plan: PLAN_READY
/waicc-develop                                      # authorises the work; Pi prepares ONE coding handoff
/waicc-dispatch codex --implement --check "npm test"
                                                    # Codex codes in an isolated git worktree; only
                                                    # changes inside the plan's paths come back
/waicc-continue                                     # Pi inspects the diff and the test results
/waicc-review Check the export format and tests
/waicc-dispatch sol                                 # another model reviews the actual code
/waicc-continue                                     # fix and re-review until it passes
/waicc-close CSV export done
```

`opus`, `codex` and `sol` are profiles from step 2; `--via claude --model opus` names an agent
directly instead. Without `--delegate`, the main agent writes the code itself after
`/waicc-develop`.

## 6. Watch everything

```text
/waicc-tracker
```

Opens one page in your browser with every project: which agent is working, what needs you,
each session's tasks, rounds and decisions, and what each agent and the main agent spent.

## Good to know

- **Nothing is decided for you.** Agents never accept a plan, answer your decisions, close a
  contract or let a coding agent edit without `/waicc-develop` and `--implement`.
- **Stop anything:** `/waicc-dispatch --stop`. The handoff stays waiting, so you can dispatch it
  again.
- **Without a headless agent:** each handoff also has a copyable prompt (`/waicc-handoff`) to
  paste into any agent; then run `/waicc-continue`.
- **Optional settings** in your `waicc-agents.json`: a dollar budget per session, standing
  policies and low-risk auto-accept for decisions, desktop notifications, and an OS sandbox
  for checks. See [Agent profiles](../README.md#agent-profiles-choose-an-agent-per-role-once).
