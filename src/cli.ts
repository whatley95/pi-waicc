#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { json, recoverLock, loadSession } from "./files.ts";
import { configureSvnIgnore } from "./ignore.ts";
import { deleteSession, restoreSession } from "./lifecycle.ts";
import { curate, propose, recall } from "./memory.ts";
import { projectRoot } from "./source.ts";
import {
  assess,
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
import type { Assessment, SessionListFilter } from "./workflow.ts";
import type { Mode } from "./types.ts";
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
try {
  let output: unknown;
  switch (command) {
    case "start": {
      const delegated = id === "--delegate";
      output = createSession(cwd, args.slice(delegated ? 2 : 1).join(" "), delegated ? "delegate" : undefined);
      break;
    }
    case "implement":
    case "test":
      output = rest[0] === "--main"
        ? useMainWork(cwd, id, command === "implement" ? "implementation" : "testing")
        : delegateWork(cwd, id, command === "implement" ? "implementation" : "testing", rest.join(" ") ||
        (command === "implement" ? "Complete the entire accepted plan and all fixes; run relevant permitted checks" : "Verify the entire implementation and prior fixes with actual permitted checks; do not edit code/tests"));
      break;
    case "context":
      output = saveContext(cwd, id, rest.join(" "));
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
      output = setRoundLimit(cwd, id, Number(rest[0]));
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
          "waicc [--root project] start [--delegate] <requirements> | implement <session> [--main] [focus] | test <session> [--main] [focus] | context <session> <summary> | status [session|open|all|closed|deleted] | list [open|all|closed|deleted] | delete <session> | restore <session> | prepare <session> <contract.json> [planning|review] [--completion report.json|--contract for review] [focus] | continue <session> | assess <session> <assessment.json> | request <session> planning|review|advisor|implementation|testing [--completion report.json|--contract for review] <focus> | advisor <session> [--requirements REQ-001,REQ-002] <question> | close <session> <reason> | close <session> --force [reason] | reopen <session> <reason> | cancel <session> [reason] | amend <session> <requirements> | export <session> | memory [confirm|revoke <id>] | learn <source-path> <lesson> | recover-lock",
      };
  }
  process.stdout.write(json(output));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
