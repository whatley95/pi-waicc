---
name: run-pi-waicc
description: Run, drive, smoke-test or debug the pi-waicc Pi extension and its standalone waicc CLI. Use to start a WAICC session, prepare a contract/handoff, simulate an agent reply.json, continue/assess a round, export, or load the extension in a real Pi 1.2.0 process and send /waicc-* slash commands.
---

# Run pi-waicc

pi-waicc is a Pi coding-agent extension (`src/index.ts`) plus a standalone CLI
(`src/cli.ts`) over the same engine. It has no GUI. You drive it with
`.claude/skills/run-pi-waicc/driver.mjs`:

- `roundtrip`: the whole contract → handoff → reply → continue → assess → export loop through the CLI in a throwaway Git repo. It needs no Pi process and no model.
- `pi`: launches the **pinned** Pi 1.2.0 from `node_modules` in RPC mode with the extension loaded via `-e`, then sends each argument as a prompt and prints the extension's output.

All paths are relative to the repo root. Verified on native Windows 11 with Node 22.22 (both Git Bash and PowerShell).

## Prerequisites / build

Node ≥ 22.19 runs the `.ts` sources directly (type stripping), so there is no build step.

```sh
npm install --ignore-scripts
npm run check          # tsc --noEmit + full node:test suite (~200 tests), ~1 min
```

## Run (agent path)

```sh
node .claude/skills/run-pi-waicc/driver.mjs roundtrip          # prints ok/FAIL per stage, exit 1 on FAIL
node .claude/skills/run-pi-waicc/driver.mjs roundtrip --keep   # keep the temp project; prints its path + session id
```

Expected stages: `DRAFT` → `WAITING_FOR_REPLY` → (`reply.json` written) `AWAITING_ASSESSMENT`
→ (assess ready) `PLAN_READY` → (contract review requested) `WAITING_FOR_REPLY`, with a
`review` round waiting.

## Live check with a scripted model (no provider, no cost)

`live-picker.mjs` runs the real Pi 1.2.0 in RPC mode against a local fake OpenAI-compatible
server that answers with a script: `waicc_status`, then `waicc_suggest_command`, then a short
reply. It uses its own temporary `PI_CODING_AGENT_DIR`, so the user's `~/.pi` is untouched.

```sh
P=$(node .claude/skills/run-pi-waicc/driver.mjs roundtrip --keep | grep -E "^(project|session):" | awk '{print $2}' | tr '\n' ' ')
set -- $P; node .claude/skills/run-pi-waicc/live-picker.mjs "$PWD" "$1" "$2"; rm -rf "$1"
```

It prints `ok`/`FAIL` for:
- the running line around a typed and a picked command,
- the picker opening after the turn and the agent staying idle while it waits,
- the pick running the command once with no extra model turn,
- `waicc_status` giving the model no handoff prompt text.

Pi runs extension `agent_end` hooks before it reports `agent_end`, so the picker's request
arrives in the same instant, just before that event.

To drive real Pi against a project (use a `--keep` project, or any repo):

```powershell
# PowerShell
node .claude/skills/run-pi-waicc/driver.mjs pi "$env:TEMP\waicc-drive-XXXX" "/waicc-status all" "/waicc-use <session-id>" "/waicc-status" "/waicc-limit 5"
```
```sh
# Git Bash: MSYS_NO_PATHCONV=1 is mandatory (see Gotchas)
MSYS_NO_PATHCONV=1 node .claude/skills/run-pi-waicc/driver.mjs pi "<project>" "/waicc-status all"
```

The output starts with `commands: waicc-planning … waicc-memory` (11 commands), which proves the extension loaded.
After that the driver prints `> <prompt>`, any `[notify:<type>]` lines, and the `customType: "waicc"`
JSON messages that commands emit via `pi.sendMessage`.

These commands are safe without a model: status, use, limit, cancel, amend, export, memory, ignore.
`/waicc-planning`, `/waicc-review` and `/waicc-continue` (when an assessment is due) call
`pi.sendUserMessage`, which starts a model turn. With no working provider, the
session is still created (`DRAFT`) and the driver prints the prompt sent as `[user] …`,
but no assistant reply follows.

## Direct CLI (what most PRs touch)

```sh
node src/cli.ts --root <project> start "Add customer search with pagination"
node src/cli.ts --root <project> status                      # list sessions (`status all` works too)
node src/cli.ts --root <project> prepare <sid> contract.json planning "focus text"
node src/cli.ts --root <project> continue <sid>              # ingest rounds/<rid>/reply.json
node src/cli.ts --root <project> assess <sid> assessment.json
node src/cli.ts --root <project> export <sid>
```

See `driver.mjs` → `roundtrip()` for working contract/reply/assessment bodies, and `docs/PROTOCOL.md` for the schema.
For the extension's tool layer (`waicc_prepare` etc.) without the Pi runtime, the
pattern is `tests/extension.test.ts`, which uses Pi's own `loadExtensions()`.

## Run (human path)

`pi install /absolute/path/to/pi-waicc`, then type `/waicc-planning …` inside Pi's TUI.
This path is interactive and needs a configured model, so it is not useful to an agent.

## Gotchas

- **Git Bash rewrites `/waicc-status` into `C:/Program Files/Git/waicc-status`** (MSYS
  path conversion). Pi then receives plain text and sends it to the model.
  Prefix with `MSYS_NO_PATHCONV=1`, or use PowerShell.
- **`pi -p` (print mode) shows nothing for `/waicc-status`**: the command runs, but its
  output is a custom message that text and json print modes don't emit. That's why the driver uses `--mode rpc`
  plus `get_messages`.
- The driver uses `node_modules/.../pi-coding-agent/dist/cli.js` (pinned 1.2.0), not the
  global `pi`, and passes `-ne --offline --no-session -a`. Without `-a` (trust),
  every command only notifies "Trust the project in Pi…".
- The `pi` mode gives each RPC command 30 s (`WAICC_DRIVER_TIMEOUT=<seconds>` to change).
  It prints `FAIL no response to …`, `FAIL could not start Pi …` or `FAIL Pi exited early …` and exits 1 rather than hanging.
  Raise the timeout before running model-backed commands.
- Status names to assert on are `DRAFT`, `WAITING_FOR_REPLY`, `AWAITING_ASSESSMENT` and `READY_FOR_HANDOFF`.
  There is no `ASSESSING`. `verified` is always `false` by design.
- `prepare` requires each `sourceQuote` to occur verbatim in the original request.
- Start the reply from the generated `reply.example.json`, because its identity fields must stay unchanged. Then write it as `reply.json` in the same round dir.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pi prints `400 … invalid_request_error` for a slash command | The slash got path-mangled (Git Bash) and went to the model. Use `MSYS_NO_PATHCONV=1`. |
| `pi` subcommand prints only `[system]`/`[user]` lines after `/waicc-planning` | Expected without a model. The session was created; check with CLI `status`. |
| `FAIL no response to prompt "/waicc-planning …" within 30s` | Model turn is slow or stuck. Set `WAICC_DRIVER_TIMEOUT=300`, or check the provider. |
