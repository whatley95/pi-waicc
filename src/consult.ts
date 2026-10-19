import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { initialize, json, now, runtimePath, safePath } from "./files.ts";
import { runAgent, type Agent, type AgentRunner, type DispatchOptions } from "./dispatch.ts";
import { progressParser, type ProgressEvent } from "./progress.ts";
import { projectRoot } from "./source.ts";
import { ensure, text } from "./validation.ts";

/** What the main agent is stuck on, in its own words, with the evidence it has. */
export interface ConsultQuestion {
  question: string;
  tried: string;
  evidence?: string;
  paths?: string[];
  /** The selected WAICC session, if any, so the advisor knows the goal. */
  context?: string;
}
/** Consults per Pi chat when the user file does not set autoAdvisor, and the largest it may set. */
export const consultLimit = { default: 3, max: 20 };

/** Read-only and without MCP or extensions: the advisor reads the source and answers in text. */
function invocation(via: Agent, prompt: string, options: DispatchOptions, root: string): { program: string; args: string[] } {
  const { model, effort } = options;
  switch (via) {
    case "claude":
      return {
        program: "claude",
        args: [
          "-p", prompt, "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
          "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Edit,Write,NotebookEdit,Bash",
          ...(model ? ["--model", model] : []),
          ...(effort ? ["--effort", effort] : []),
        ],
      };
    case "codex":
      return {
        program: "codex",
        args: [
          // The OS sandbox keeps the project read-only; read-only commands such as git diff still work.
          "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-C", root,
          ...(model ? ["-m", model] : []),
          ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
          prompt,
        ],
      };
    case "pi":
      return {
        program: "pi",
        args: [
          "-p", "--mode", "json", "--no-session", "-ne", "--no-mcp", "--tools", "read,grep,find,ls",
          ...(model ? ["--model", model] : []),
          ...(effort ? ["--thinking", effort] : []),
          prompt,
        ],
      };
    case "agy":
      return {
        program: "agy",
        args: [
          "-p", prompt, "--output-format", "stream-json", "--sandbox",
          "--print-timeout", `${options.timeoutMinutes ?? consultMinutes}m`,
          ...(model ? ["--model", model] : []),
          ...(effort ? ["--effort", effort] : []),
        ],
      };
  }
}
const consultMinutes = 15;

/** The agent's final answer in full; progress notes are shortened to one line. */
function answerReader(via: Agent) {
  let answer = "";
  const texts = (content: unknown): string =>
    Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => String(part.text)).join("\n").trim() : "";
  return {
    read(line: string): void {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (!j || typeof j !== "object") return;
      let found = "";
      if (via === "claude") found = j.type === "result" && typeof j.result === "string" ? j.result : j.type === "assistant" ? texts(j.message?.content) : "";
      else if (via === "codex") found = j.type === "item.completed" && j.item?.type === "agent_message" ? String(j.item.text ?? "") : "";
      else if (via === "pi") found = j.type === "message_end" && j.message?.role === "assistant" ? texts(j.message.content) : "";
      else found = typeof j.result === "string" ? j.result : typeof j.text === "string" && /message|text/i.test(String(j.type ?? "")) ? j.text : "";
      if (found.trim()) answer = found.trim();
    },
    get: () => answer,
  };
}

const tail = (value: string, limit = 8_000): string => (value.length > limit ? value.slice(-limit) : value);

function brief(q: ConsultQuestion): string {
  const section = (title: string, body: string | undefined) => (body?.trim() ? `## ${title}\n\n${body.trim()}\n\n` : "");
  return `# Advice request from the main coding agent\n\n${section("Question", q.question)}${section("What was already tried", q.tried)}${section("Evidence: errors, failing output, observations", q.evidence)}${section("Files to start from", q.paths?.map((path) => `- ${path}`).join("\n"))}${section("The work this belongs to", q.context)}`;
}

/**
 * Asks the advisor one question, outside any handoff: no round, no contract change, no reply
 * file. The brief and the answer are kept under the project's WAICC state for later reading.
 */
export async function consultAdvisor(cwd: string, q: ConsultQuestion, options: DispatchOptions, run: AgentRunner = runAgent,
  signal?: AbortSignal, onProgress?: (event: ProgressEvent) => void) {
  const question = text(q.question, "Question", 4_000).trim();
  const tried = text(q.tried, "What was tried", 8_000).trim();
  ensure(question && tried, "Say what you are stuck on and what you already tried");
  ensure(!q.paths || (q.paths.length <= 20 && q.paths.every((path) => typeof path === "string" && path.length <= 500)), "At most 20 file paths");
  const root = projectRoot(cwd);
  initialize(root);
  const id = randomUUID();
  const folder = `${runtimePath}/consults/${id}`;
  const briefPath = safePath(root, `${folder}/brief.md`);
  mkdirSync(dirname(briefPath), { recursive: true });
  writeFileSync(briefPath, brief({ ...q, question, tried, evidence: q.evidence === undefined ? undefined : text(q.evidence, "Evidence", 24_000) }));
  // One line: it travels as a command-line argument on every platform.
  const prompt = `You are a senior engineer giving a second opinion to another coding agent that is stuck, for the project at ${JSON.stringify(root)}. First read the advice request at ${JSON.stringify(briefPath)}. Then investigate the source yourself, read-only: never edit, create or delete files, and run nothing that changes state. Find the most likely cause or the best approach and cite file:line evidence for each claim. Answer in plain text with: Diagnosis (what is really going on, with evidence), Recommended next step (small and concrete), If that does not work (the next hypothesis), and How to confirm (the check that proves it). If the evidence is not enough, say exactly what is missing instead of guessing. Do not restate the request. Stay under 500 words.`;
  const { program, args } = invocation(options.via, prompt, options, root);
  const startedAt = Date.now();
  const parse = progressParser(options.via, root, startedAt);
  const reader = answerReader(options.via);
  const progress: ProgressEvent[] = [];
  let result;
  try {
    result = await run(program, args, {
      cwd: root, timeout: (options.timeoutMinutes ?? consultMinutes) * 60_000, signal, env: {},
      onLine: (line) => {
        reader.read(line);
        for (const event of parse(line)) {
          progress.push(event);
          if (progress.length > 200) progress.splice(0, progress.length - 200);
          onProgress?.(event);
        }
      },
    });
  } catch (error) {
    result = { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1, killed: Boolean(signal?.aborted) };
  }
  // A runner that returns stdout without streaming it (tests, older agents) still yields its answer.
  if (!reader.get()) for (const line of result.stdout.split(/\r?\n/)) reader.read(line);
  const answer = reader.get();
  const record = {
    schemaVersion: 1, consultId: id, via: options.via, model: options.model ?? null, effort: options.effort ?? null,
    finishedAt: now(), durationMs: Date.now() - startedAt, code: result.code, killed: result.killed,
    answer: answer || null, progress, stderr: tail(result.stderr),
  };
  writeFileSync(safePath(root, `${folder}/result.json`), json(record));
  return { ...record, brief: briefPath, log: safePath(root, `${folder}/result.json`), steps: progress.length };
}
