#!/usr/bin/env node
// Agent driver for pi-waicc. Run from the repo root:
//   node .claude/skills/run-pi-waicc/driver.mjs roundtrip [--keep]
//   node .claude/skills/run-pi-waicc/driver.mjs pi <project-dir> "/waicc-status all" ["/waicc-use <id>" ...]
// `roundtrip` exercises the standalone CLI end to end in a throwaway Git project
// (no Pi process, no model). `pi` launches the pinned Pi 1.2.0 in RPC mode with this
// extension loaded and sends each argument as a prompt; output is the extension's
// notify/custom messages. Commands that call pi.sendUserMessage (/waicc-planning,
// /waicc-review, /waicc-continue on a waiting reply) start a model turn - avoid them
// unless a provider is configured.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliTs = join(repo, "src", "cli.ts");
const piCli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const [sub, ...argv] = process.argv.slice(2);

function waicc(root, ...args) {
  const r = spawnSync(process.execPath, [cliTs, "--root", root, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`waicc ${args[0]} failed (${r.status}): ${r.stderr.trim()}`);
  return JSON.parse(r.stdout);
}
function expect(label, actual, wanted) {
  const ok = actual === wanted;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${actual}${ok ? "" : ` (wanted ${wanted})`}`);
  if (!ok) process.exitCode = 1;
}

function roundtrip(keep) {
  const root = mkdtempSync(join(tmpdir(), "waicc-drive-"));
  const git = (...a) => spawnSync("git", ["-C", root, "-c", "user.email=d@d", "-c", "user.name=d", ...a]);
  writeFileSync(join(root, "index.js"), "export const x = 1;\n");
  git("init", "-q"); git("add", "."); git("commit", "-qm", "init");
  console.log(`project: ${root}`);

  const s = waicc(root, "start", "Add customer search with pagination");
  expect("start status", s.status, "DRAFT");
  const contractPath = join(root, "..", `${s.id}.contract.json`);
  writeFileSync(contractPath, JSON.stringify({
    title: "Customer search",
    requirements: [{ id: "REQ-001", text: "Search customers with pagination", sourceQuote: "Add customer search" }],
    exclusions: [], assumptions: [], questions: [], risks: [],
    tasks: [{ id: "API", title: "Search", requirementIds: ["REQ-001"], dependsOn: [], allowedPaths: ["index.js"],
      acceptance: [{ id: "AC-001", text: "Paged results", requirementIds: ["REQ-001"], verification: "Unit test pagination" }] }],
    skills: ["wai-node"],
  }));
  const p = waicc(root, "prepare", s.id, contractPath, "planning", "Plan the search");
  rmSync(contractPath);
  expect("prepare status", p.status, "WAITING_FOR_REPLY");
  const round = p.rounds.at(-1).id;
  const dir = join(root, ".pi/pi-waicc/sessions", s.id, "rounds", round);
  console.log(`handoff: ${join(dir, "HANDOFF.md")}`);

  // Play the external agent: fill the generated template and save as reply.json.
  const reply = JSON.parse(readFileSync(join(dir, "reply.example.json"), "utf8"));
  Object.assign(reply, {
    outcome: "ready", summary: "Plan agreed: add paged search in index.js.",
    coverage: [{ requirementId: "REQ-001", status: "addressed", evidence: "index.js is the only module" }],
    questions: [],
    checks: [{ description: "Read index.js", outcome: "passed", evidence: "exports x" }],
  });
  writeFileSync(join(dir, "reply.json"), JSON.stringify(reply, null, 2));
  const c = waicc(root, "continue", s.id);
  expect("continue status", c.status, "AWAITING_ASSESSMENT");

  const assessment = join(root, "..", `${s.id}.assessment.json`);
  writeFileSync(assessment, JSON.stringify({ requestId: round, decision: "ready", rationale: "Coverage complete.", dispositions: [] }));
  const a = waicc(root, "assess", s.id, assessment);
  rmSync(assessment);
  expect("assess status", a.status, "READY_FOR_HANDOFF");
  expect("next round mode", a.rounds.at(-1).mode, "implementation");
  const st = waicc(root, "status", s.id);
  console.log(`status: ${st.status}, rounds ${st.rounds}/${st.maxRounds}, verified=${st.verified}`);
  console.log(`export: ${waicc(root, "export", s.id).exportPath}`);
  console.log(`session: ${s.id}`);
  if (!keep) rmSync(root, { recursive: true, force: true });
}

async function drivePi(project, prompts) {
  const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--offline", "--no-session", "-ne", "-a", "-e", join(repo, "src/index.ts")],
    { cwd: resolve(project), stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === "response" && waiters.has(ev.id)) { waiters.get(ev.id)(ev); waiters.delete(ev.id); }
      else if (ev.type === "extension_ui_request" && ev.method === "notify") console.log(`[notify:${ev.notifyType}] ${ev.message}`);
    }
  });
  // Fail fast instead of hanging: per-command timeout, and any early Pi exit fails pending commands.
  const fail = (why) => { console.error(`FAIL ${why}`); child.kill(); process.exit(1); };
  child.on("error", (e) => fail(`could not start Pi in ${resolve(project)}: ${e.code ?? e.message} (does the project dir exist?)`));
  child.on("exit", (code) => { if (!done) fail(`Pi exited early (code ${code}) - check stderr above`); });
  let n = 0, done = false;
  const send = (cmd) => new Promise((ok) => {
    const id = `d${++n}`;
    const timer = setTimeout(() => fail(`no response to ${cmd.type}${cmd.message ? ` "${cmd.message}"` : ""} within ${timeoutMs / 1000}s`), timeoutMs);
    waiters.set(id, (ev) => { clearTimeout(timer); ok(ev); });
    child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
  });
  const cmds = await send({ type: "get_commands" });
  console.log(`commands: ${cmds.data.commands.map((c) => c.name).filter((x) => x.startsWith("waicc")).join(" ")}`);
  for (const message of prompts) {
    console.log(`> ${message}`);
    const before = (await send({ type: "get_messages" })).data.messages.length;
    await send({ type: "prompt", message });
    const msgs = (await send({ type: "get_messages" })).data.messages.slice(before);
    for (const m of msgs) {
      if (m.role === "custom" || m.customType) console.log(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      else console.log(`[${m.role}] ${JSON.stringify(m.content).slice(0, 300)}`);
    }
  }
  done = true;
  child.stdin.end(); child.kill();
}
const timeoutMs = Number(process.env.WAICC_DRIVER_TIMEOUT ?? 30) * 1000;

if (sub === "roundtrip") roundtrip(argv.includes("--keep"));
else if (sub === "pi" && argv[0]) await drivePi(argv[0], argv.slice(1));
else { console.error("usage: driver.mjs roundtrip [--keep] | pi <project-dir> <prompt>..."); process.exit(2); }
