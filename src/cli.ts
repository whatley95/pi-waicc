#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { json, recoverLock, loadSession } from "./files.ts";
import { configureSvnIgnore } from "./ignore.ts";
import { deleteSession, restoreSession } from "./lifecycle.ts";
import { curate, propose, recall } from "./memory.ts";
import { projectRoot } from "./source.ts";
import { checkpointView, refreshCheckpoint } from "./checkpoint.ts";
import {
  assess,
  beginDevelopment,
  decisionsView,
  resolveDecision,
  amend,
  cancel,
  closeSession,
  createSession,
  delegateWork,
  exportHandoff,
  forceCloseSession,
  ingest,
  issue,
  prepare,
  reopenSession,
  setRoundLimit,
  status,
  saveContext,
  useMainWork,
} from "./workflow.ts";
import { advisorInput, ensure } from "./validation.ts";
import { dispatch, dispatchOptions } from "./dispatch.ts";
import { serveMcp } from "./mcp.ts";
import type { Assessment, SessionListFilter } from "./workflow.ts";
import type { Mode, RoundPhase } from "./types.ts";
import type { ReviewRequest } from "./review.ts";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
let cwd = process.cwd();
if (rootIndex >= 0) {
  ensure(args[rootIndex + 1], "--root requires a directory");
  cwd = resolve(args[rootIndex + 1]);
  args.splice(rootIndex, 2);
}
const [command, id, ...rest] = args;
const file = (path: string) =>
  JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
function reviewInput(input: string[]): { review: ReviewRequest; focus: string } {
  ensure(
    input[0] === "--contract" || (input[0] === "--completion" && input[1]),
    "Review code changes with --completion <whole-work-report.json>, or explicitly use --contract for specification-only review",
  );
  return input[0] === "--contract"
    ? { review: { kind: "contract" }, focus: input.slice(1).join(" ") }
    : {
        review: { kind: "code", completion: file(input[1]) },
        focus: input.slice(2).join(" "),
      };
}
function flag(input: string[], name: string): string | undefined {
  const index = input.indexOf(name);
  if (index < 0) return undefined;
  ensure(input[index + 1], `${name} requires a value`);
  return input[index + 1];
}
try {
  let output: unknown;
  switch (command) {
    case "mcp": {
      // stdout belongs to the protocol: nothing else may be written to it.
      const options = args.slice(1);
      ensure(options.every((word, i) => i % 2 === 1 || ["--session", "--request"].includes(word)), "Usage: waicc mcp [--session <id> --request <id>]");
      await serveMcp(cwd, { sessionId: flag(options, "--session"), requestId: flag(options, "--request") });
      process.exit(0);
    }
    case "dispatch":
      ensure(id, "Usage: waicc dispatch <session> --via claude|codex|pi|agy [--model <model>] [--timeout <minutes>]");
      output = await dispatch(cwd, id, dispatchOptions(rest.join(" ")));
      break;
    case "start": {
      const delegated = id === "--delegate";
      output = createSession(cwd, args.slice(delegated ? 2 : 1).join(" "), delegated ? "delegate" : undefined, "planning");
      break;
    }
    case "help-develop":
    case "implement":
    case "test": {
      const mode = command === "test" ? "testing" : "implementation";
      output = rest[0] === "--main"
        ? useMainWork(cwd, id, mode)
        : delegateWork(cwd, id, mode, rest.join(" ") ||
        (mode === "implementation" ? "Complete the entire accepted plan and all fixes; run relevant permitted checks" : "Verify the entire implementation and prior fixes with actual permitted checks; do not edit code/tests"));
      break;
    }
    case "develop":
      ensure(id && rest.length <= 1 && (!rest[0] || ["--main", "--delegate"].includes(rest[0])), "Usage: waicc develop <session-id> [--main|--delegate]");
      output = beginDevelopment(cwd, id, rest[0] === "--main" ? "main" : rest[0] === "--delegate" ? "delegate" : undefined);
      break;
    case "decisions":
      ensure(id && !rest.length, "Usage: waicc decisions <session-id>");
      output = decisionsView(cwd, id);
      break;
    case "decide":
      ensure(id && rest.length >= 2, "Usage: waicc decide <session-id> <decision-id> <answer>");
      output = resolveDecision(cwd, id, rest[0], rest.slice(1).join(" "));
      break;
    case "context":
      output = saveContext(cwd, id, rest.join(" "));
      break;
    case "compact":
      ensure(id && rest.length === 0, "Usage: waicc compact <session-id> (checkpoint only; Pi owns chat compaction)");
      output = refreshCheckpoint(cwd, id);
      break;
    case "checkpoint":
      ensure(id && rest.length === 0, "Usage: waicc checkpoint <session-id>");
      output = checkpointView(projectRoot(cwd), loadSession(projectRoot(cwd), id));
      break;
    case "status":
      output = ["open", "all", "closed", "deleted"].includes(id)
        ? status(cwd, undefined, id as SessionListFilter)
        : status(cwd, id);
      break;
    case "list":
      ensure(
        (!id || ["open", "all", "closed", "deleted"].includes(id)) &&
          rest.length === 0,
        "Usage: waicc list [open|all|closed|deleted]",
      );
      output = status(cwd, undefined, (id || "open") as SessionListFilter);
      break;
    case "delete":
      ensure(id && rest.length === 0, "Usage: waicc delete <session-id>");
      output = deleteSession(cwd, id);
      break;
    case "restore":
      ensure(id && rest.length === 0, "Usage: waicc restore <session-id>");
      output = restoreSession(cwd, id);
      break;
    case "prepare": {
      const s = loadSession(projectRoot(cwd), id);
      const mode = (rest[1] ?? "planning") as Mode;
      const review = mode === "review" ? reviewInput(rest.slice(2)) : undefined;
      output = prepare(
        cwd,
        id,
        file(rest[0]),
        mode,
        (review?.focus ?? rest.slice(2).join(" ")) ||
          "Inspect this contract against the original requirements and actual project.",
        s.contractVersion,
        review?.review,
      );
      break;
    }
    case "continue":
      output = ingest(cwd, id);
      break;
    case "assess":
      output = assess(cwd, id, file(rest[0]) as Assessment);
      break;
    case "request": {
      const review = rest[0] === "review" ? reviewInput(rest.slice(1)) : undefined;
      const focus = review
        ? review.focus || "Review all changes against requirements and actual evidence"
        : rest.slice(1).join(" ");
      output = issue(
        cwd, id, rest[0] as Mode,
        focus,
        undefined, undefined, review?.review,
      );
      break;
    }
    case "advisor": {
      const input = advisorInput(rest.join(" "));
      output = issue(
        cwd,
        id,
        "advisor",
        input.question,
        undefined,
        input.requirementIds,
      );
      break;
    }
    case "cancel":
      output = cancel(cwd, id, rest.join(" ") || undefined);
      break;
    case "close":
      output =
        rest[0] === "--force"
          ? forceCloseSession(cwd, id, rest.slice(1).join(" ") || undefined)
          : closeSession(cwd, id, rest.join(" "));
      break;
    case "reopen":
      output = reopenSession(cwd, id, rest.join(" "));
      break;
    case "amend":
      output = amend(cwd, id, rest.join(" "));
      break;
    case "export":
      output = {
        exportPath: exportHandoff(cwd, id),
        includesSourceCode: false,
        whatToSend:
          "Provide the ENTIRE export folder and paste its STARTER.txt CONTENTS; the recipient also needs matching project source. Return reply.json to manifest.returnReplyTo, then continue in the coordinator.",
      };
      break;
    case "limit":
      ensure(rest.length === 1 || rest.length === 2, "Usage: waicc limit <session> [phase] <2-20>");
      output = setRoundLimit(cwd, id, Number(rest.at(-1)), rest.length === 2 ? rest[0] as RoundPhase : undefined);
      break;
    case "ignore":
      output = configureSvnIgnore(projectRoot(cwd));
      break;
    case "memory":
      output = ["confirm", "revoke"].includes(id)
        ? curate(cwd, rest[0], id as "confirm" | "revoke")
        : recall(cwd, args.slice(1).join(" "), true);
      break;
    case "learn":
      output = propose(cwd, rest.join(" "), id);
      break;
    case "recover-lock":
      recoverLock(projectRoot(cwd));
      output = { recovered: true };
      break;
    default:
      if (command && command !== "help" && command !== "--help")
        process.exitCode = 2;
      output = {
        usage:
          "waicc [--root project] start [--delegate] <requirements> | dispatch <session> --via claude|codex|pi|agy [--model <model>] [--timeout <minutes>] | mcp [--session <id> --request <id>] | develop <session> [--main|--delegate] | decisions <session> | decide <session> <decision-id> <answer> | help-develop <session> [--main] [focus] | implement <session> [--main] [focus] (alias of help-develop) | test <session> [--main] [focus] | context <session> <summary> | compact <session> | checkpoint <session> | status [session|open|all|closed|deleted] | list [open|all|closed|deleted] | delete <session> | restore <session> | prepare <session> <contract.json> [planning|review] [--completion report.json|--contract for review] [focus] | continue <session> | assess <session> <assessment.json> | request <session> planning|review|advisor|implementation|testing [--completion report.json|--contract for review] <focus> | advisor <session> [--requirements REQ-001,REQ-002] <question> | close <session> <reason> | close <session> --force [reason] | reopen <session> <reason> | cancel <session> [reason] | amend <session> <requirements> | export <session> | limit <session> [phase] <2-20> | memory [confirm|revoke <id>] | learn <source-path> <lesson> | recover-lock",
      };
  }
  process.stdout.write(json(output));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
