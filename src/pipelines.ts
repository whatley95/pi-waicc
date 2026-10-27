import { execFile } from "node:child_process";
import type { GitLabCall } from "./gitlab.ts";
import type { Shipped } from "./types.ts";

/**
 * After /waicc-ship: the shipped commit's CI pipeline, read-only. GitLab through its API (the
 * host's token), GitHub through gh. A failure brings back the failed jobs' last log lines, which
 * are the build's output, not instructions.
 */
export type PipelineState = "pending" | "success" | "failed" | "canceled" | "manual" | "none";
export interface FailedJob { name: string; url: string | null; log: string }
export interface PipelineResult { state: PipelineState; url: string | null; failed: FailedJob[] }

const logTail = 6_000;
/** The end of a job log, without terminal colors or GitLab's section markers. */
export function cleanLog(text: string): string {
  const clean = text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/section_(start|end):\d+:[^\r\n]*?\r/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length > logTail ? `…${clean.slice(-logTail)}` : clean;
}

export async function gitlabPipeline(call: GitLabCall, shipped: Shipped): Promise<PipelineResult> {
  const pipelines = await call("GET", `/pipelines?sha=${shipped.commit}&order_by=id&sort=desc&per_page=5`);
  const latest = Array.isArray(pipelines) ? pipelines[0] : undefined;
  if (!latest) return { state: "pending", url: null, failed: [] };
  const url = latest.web_url ? String(latest.web_url) : null;
  const status = String(latest.status ?? "");
  if (status === "success") return { state: "success", url, failed: [] };
  if (status === "canceled" || status === "skipped") return { state: "canceled", url, failed: [] };
  if (status === "manual") return { state: "manual", url, failed: [] };
  if (status !== "failed") return { state: "pending", url, failed: [] };
  const jobs = await call("GET", `/pipelines/${latest.id}/jobs?scope[]=failed&per_page=10`);
  const failed: FailedJob[] = [];
  for (const job of (Array.isArray(jobs) ? jobs : []).filter((j: any) => !j.allow_failure).slice(0, 3)) {
    let log = "";
    try {
      const trace = await call("GET", `/jobs/${job.id}/trace`);
      log = cleanLog(typeof trace === "string" ? trace : "");
    } catch (error) {
      log = `(log unavailable: ${error instanceof Error ? error.message : String(error)})`;
    }
    failed.push({ name: `${job.stage ? `${job.stage}: ` : ""}${job.name}`, url: job.web_url ? String(job.web_url) : null, log });
  }
  return { state: "failed", url, failed };
}

export type GhRunner = (root: string, args: string[]) => Promise<{ code: number; out: string }>;
export const runGh: GhRunner = (root, args) => new Promise((resolve) => {
  execFile("gh", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 32_000_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout, stderr) =>
    resolve({ code: error ? Number((error as { code?: number }).code) || 1 : 0, out: stdout || stderr }));
});

/** gh pr checks: pass and skipping count as passed; any fail fails; anything else is still running. */
export async function githubChecks(root: string, shipped: Shipped, gh: GhRunner = runGh): Promise<PipelineResult> {
  // gh exits non-zero while checks fail or are pending, but still prints them.
  const listed = await gh(root, ["pr", "checks", shipped.branch, "--json", "name,state,bucket,link"]);
  let checks: { name: string; bucket: string; link: string }[];
  try {
    checks = JSON.parse(listed.out);
  } catch {
    // Checks take a moment to register: until then there is no pipeline to point at.
    return { state: /no checks reported/i.test(listed.out) ? "none" : "pending", url: null, failed: [] };
  }
  if (!checks.length) return { state: "pending", url: null, failed: [] };
  const failing = checks.filter((check) => check.bucket === "fail");
  if (!failing.length)
    return { state: checks.some((check) => check.bucket === "pending") ? "pending" : checks.some((check) => check.bucket === "cancel") ? "canceled" : "success", url: shipped.request.url, failed: [] };
  const failed: FailedJob[] = [];
  const runs = new Set<string>();
  for (const check of failing.slice(0, 3)) {
    const run = /\/actions\/runs\/(\d+)/.exec(check.link ?? "")?.[1];
    let log = "";
    if (run && !runs.has(run)) {
      runs.add(run);
      const viewed = await gh(root, ["run", "view", run, "--log-failed"]);
      log = cleanLog(viewed.out);
    }
    failed.push({ name: check.name, url: check.link || null, log });
  }
  return { state: "failed", url: shipped.request.url, failed };
}

/** What the main agent gets to fix a failed pipeline: the job names and their log tails, as data. */
export function failureText(result: PipelineResult): string {
  return result.failed.map((job) => `### ${job.name}${job.url ? ` (${job.url})` : ""}\n\n\`\`\`text\n${job.log || "(no log)"}\n\`\`\``).join("\n\n");
}
