#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { json, recoverLock, loadSession } from "./files.ts";
import { configureSvnIgnore } from "./ignore.ts";
import { curate, propose, recall } from "./memory.ts";
import { projectRoot } from "./source.ts";
import {
  assess,
  amend,
  cancel,
  createSession,
  exportHandoff,
  ingest,
  issue,
  prepare,
  setRoundLimit,
  status,
} from "./workflow.ts";
import { ensure } from "./validation.ts";
import type { Assessment } from "./workflow.ts";
import type { Mode } from "./types.ts";

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
try {
  let output: unknown;
  switch (command) {
    case "start":
      output = createSession(cwd, args.slice(1).join(" "));
      break;
    case "status":
      output = status(cwd, id === "all" ? undefined : id);
      break;
    case "prepare": {
      const s = loadSession(projectRoot(cwd), id);
      output = prepare(
        cwd,
        id,
        file(rest[0]),
        (rest[1] ?? "planning") as Mode,
        rest.slice(2).join(" ") ||
          "Inspect this contract against the original requirements and actual project.",
        s.contractVersion,
      );
      break;
    }
    case "continue":
      output = ingest(cwd, id);
      break;
    case "assess":
      output = assess(cwd, id, file(rest[0]) as Assessment);
      break;
    case "request":
      output = issue(cwd, id, rest[0] as Mode, rest.slice(1).join(" "));
      break;
    case "cancel":
      output = cancel(cwd, id, rest.join(" "));
      break;
    case "amend":
      output = amend(cwd, id, rest.join(" "));
      break;
    case "export":
      output = { exportPath: exportHandoff(cwd, id) };
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
          "waicc [--root project] start <requirements> | status [session] | prepare <session> <contract.json> [planning|review] [focus] | continue <session> | assess <session> <assessment.json> | request <session> planning|review <focus> | cancel <session> <reason> | amend <session> <requirements> | export <session> | memory [confirm|revoke <id>] | learn <source-path> <lesson> | recover-lock",
      };
  }
  process.stdout.write(json(output));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
