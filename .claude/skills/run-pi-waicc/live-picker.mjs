// Live check: a real Pi 1.4.0 (RPC) with WAICC loaded, driven by a scripted local "model".
// Usage: node .claude/skills/run-pi-waicc/live-picker.mjs <repo> <project> <sessionId> (see SKILL.md)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [repo, project, sid] = process.argv.slice(2);
const requests = [];
const say = (...a) => console.log(...a);
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;

// The scripted model: status, then suggest a command, then a short final answer.
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const json = JSON.parse(body || "{}");
    requests.push(json);
    const tools = (json.messages ?? []).filter((m) => m.role === "tool").length;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const call = (name, args) => {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${tools}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      chunk({}, "tool_calls");
    };
    if (tools === 0) call("waicc_status", { sessionId: sid });
    else if (tools === 1) call("waicc_suggest_command", { commands: [{ command: "/waicc-list all", why: "see every session" }], question: "Live check: run this?" });
    else { chunk({ role: "assistant", content: "Offered. Ending my turn." }); chunk({}, "stop"); }
    res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const port = server.address().port;

const agentDir = mkdtempSync(join(tmpdir(), "waicc-live-agent-"));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "scripted", reasoning: false }] } } }));

const piCli = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const child = spawn(process.execPath, [piCli, "--mode", "rpc", "--offline", "--no-session", "-ne", "-a", "-e", join(repo, "src/index.ts"), "--provider", "fake", "--model", "scripted"],
  { cwd: resolve(project), stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
let buf = "", n = 0;
const waiters = new Map(), log = [];
const listeners = [];
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "response" && waiters.has(ev.id)) { waiters.get(ev.id)(ev); waiters.delete(ev.id); continue; }
    if (ev.type === "extension_ui_request") {
      const what = ev.method === "setWidget" ? `setWidget ${ev.widgetKey} ${JSON.stringify(ev.widgetLines ?? null)}`
        : ev.method === "select" ? `select "${ev.title}" ${JSON.stringify(ev.options)}`
        : ev.method === "notify" ? `notify:${ev.notifyType} ${String(ev.message).slice(0, 120)}` : ev.method;
      log.push(`${at()} ui ${what}`);
    } else if (["agent_start", "agent_end", "agent_settled", "tool_execution_start", "tool_execution_end"].includes(ev.type)) {
      log.push(`${at()} ${ev.type}${ev.toolName ? ` ${ev.toolName}` : ""}`);
    }
    for (const l of [...listeners]) l(ev);
  }
});
const send = (cmd) => new Promise((ok) => { const id = `d${++n}`; waiters.set(id, ok); child.stdin.write(JSON.stringify({ ...cmd, id }) + "\n"); });
const next = (match, ms = 60_000) => new Promise((ok, fail) => {
  const timer = setTimeout(() => fail(new Error(`timed out waiting (${ms} ms)`)), ms);
  const l = (ev) => { if (match(ev)) { clearTimeout(timer); listeners.splice(listeners.indexOf(l), 1); ok(ev); } };
  listeners.push(l);
});
const check = (ok, what) => say(`${ok ? "ok  " : "FAIL"} ${what}`);
try {
  const cmds = await send({ type: "get_commands" });
  check(cmds.data.commands.some((c) => c.name === "waicc-list"), "WAICC loaded in Pi 1.4.0");

  // 1. A typed command: the running line appears, then clears.
  log.length = 0;
  await send({ type: "prompt", message: `/waicc-use ${sid}` });
  await new Promise((ok) => setTimeout(ok, 500));
  const widgets = log.filter((l) => l.includes("setWidget waicc-busy"));
  check(widgets.length === 2 && widgets[0].includes("running /waicc-use") && widgets[1].endsWith("null"), `running line shown then cleared for /waicc-use: ${widgets.join(" | ")}`);

  // 2. An agent turn that suggests a command.
  log.length = 0;
  const settled = next((ev) => ev.type === "agent_end");
  const picker = next((ev) => ev.type === "extension_ui_request" && ev.method === "select");
  await send({ type: "prompt", message: "Check the session, then suggest the next WAICC command." });
  await settled;
  const pick = await picker;
  // Pi runs extension agent_end hooks before it reports agent_end, so the picker comes in the same instant.
  const toolAt = log.findIndex((l) => l.includes("tool_execution_end waicc_suggest_command"));
  const selectAt = log.findIndex((l) => l.includes("ui select"));
  check(toolAt >= 0 && selectAt > toolAt && requests.length === 3, `picker opened after the tool returned and the model's last reply (${requests.length} model requests)`);
  check(pick.options[0].startsWith("/waicc-list all") && pick.options.at(-1) === "None of these", `picker rows: ${JSON.stringify(pick.options)}`);

  // What the model received from waicc_status: no prompt text to paste.
  const statusResult = requests[1]?.messages?.find((m) => m.role === "tool")?.content;
  const text = typeof statusResult === "string" ? statusResult : JSON.stringify(statusResult ?? "");
  check(text.includes("Not shown to you. /waicc-handoff shows and copies it") && !text.includes("copyPastePrompt") && !/You are the WAICC \w+ recipient/.test(text),
    `waicc_status result carries no handoff prompt (${text.length} chars)`);
  const all = JSON.stringify(requests);
  check(!all.includes("copy-only block"), "no 'copy-only block' instruction anywhere in what the model was sent");
  const suggestResult = requests[2]?.messages?.filter((m) => m.role === "tool").at(-1)?.content;
  check(JSON.stringify(suggestResult ?? "").includes("Offered to the human in a picker that opens when your turn ends"), "the suggest tool returned at once");

  // 3. Leave the picker open a while: nothing is working, then pick.
  await new Promise((ok) => setTimeout(ok, 3000));
  const state = await send({ type: "get_state" });
  check(state.data && state.data.isStreaming === false, `agent idle while the picker waits (isStreaming ${state.data?.isStreaming})`);
  say("--- event log (agent turn) ---");
  for (const l of log) say(l);
  log.length = 0;
  const before = (await send({ type: "get_messages" })).data.messages.length;
  child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: pick.id, value: pick.options[0] }) + "\n");
  await new Promise((ok) => setTimeout(ok, 1500));
  const after = (await send({ type: "get_messages" })).data.messages.slice(before);
  check(after.some((m) => m.customType === "waicc" || m.role === "custom"), `the picked /waicc-list ran and showed its output (${after.length} new message(s))`);
  const w2 = log.filter((l) => l.includes("setWidget waicc-busy"));
  check(w2.length === 2 && w2[0].includes("running /waicc-list"), `running line for the picked command: ${w2.join(" | ")}`);
  check(requests.length === 3, `no extra model turn after the pick (${requests.length} model requests)`);
} catch (error) {
  say(`FAIL ${error.message}`);
} finally {
  say("--- event log (last step) ---");
  for (const l of log) say(l);
  child.kill(); server.close();
  rmSync(agentDir, { recursive: true, force: true });
}
