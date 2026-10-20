import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import * as tls from "node:tls";
import { ensure } from "./validation.ts";
import type { Reply, Round, Session } from "./types.ts";

/**
 * GitLab's API, for posting a review to its merge request after the human confirms. A token is
 * sent only to a host named in the user file, so a repository's remote cannot redirect it.
 */
export interface GitLabHost { token: string | null; allowHttp: boolean }
export interface GitLabProject { origin: string; host: string; path: string; secure: boolean }

/** The API's origin and project path from a remote URL: https, http or SSH (git@host:group/project.git). */
export function gitlabProject(remoteUrl: string): GitLabProject {
  const url = remoteUrl.trim();
  let host: string, path: string, secure = true;
  const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(url);
  if (scp) [host, path] = [scp[1], scp[2]];
  else {
    const parsed = (() => {
      try {
        return new URL(url);
      } catch {
        return null;
      }
    })();
    ensure(parsed && ["https:", "http:", "ssh:"].includes(parsed.protocol), `Cannot tell the GitLab server from the remote ${JSON.stringify(url)}`);
    secure = parsed.protocol !== "http:";
    // An SSH remote's port is SSH's, not the web server's.
    host = parsed.protocol === "ssh:" ? parsed.hostname : parsed.host;
    path = parsed.pathname;
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  ensure(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(path), `Cannot tell the GitLab project from the remote ${JSON.stringify(url)}`);
  return { origin: `${secure ? "https" : "http"}://${host}`, host, path, secure };
}

// The system's certificates as well as Node's own, so an internal GitLab trusted by Windows (and git) works.
let trusted: string[] | undefined;
const certificates = (): string[] | undefined => {
  try {
    trusted ??= [...new Set([...tls.getCACertificates("system"), ...tls.getCACertificates("bundled")])];
    return trusted;
  } catch {
    return undefined;
  }
};

export type GitLabCall = (method: "GET" | "POST", path: string, body?: unknown) => Promise<any>;
/** Calls the API with the host's token; errors carry GitLab's own message. */
export function gitlabClient(project: GitLabProject, settings: GitLabHost): GitLabCall {
  ensure(settings.token, `No GitLab token for ${project.host}: set "token" or "tokenEnv" for it under "gitlab" in your user file`);
  ensure(project.secure || settings.allowHttp, `${project.host} is reached over plain http, which would send your token unencrypted. Add "allowHttp": true for it under "gitlab" in your user file if that network is trusted.`);
  const base = `${project.origin}/api/v4/projects/${encodeURIComponent(project.path)}`;
  return (method, path, body) => new Promise((resolve, reject) => {
    const target = new URL(`${base}${path}`);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(target, {
      method, timeout: 30_000,
      headers: { "PRIVATE-TOKEN": settings.token!, Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
      ...(target.protocol === "https:" && certificates() ? { ca: certificates() } : {}),
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch { /* not JSON: reported as text */ }
        if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) return resolve(json);
        const message = json?.message ? (typeof json.message === "string" ? json.message : JSON.stringify(json.message)) : json?.error ?? text.slice(0, 200);
        const error = new Error(`GitLab ${method} ${path.split("?")[0]} failed (HTTP ${res.statusCode}): ${message}`) as Error & { status?: number };
        error.status = res.statusCode;
        reject(error);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`GitLab did not answer within 30 s (${project.host})`)));
    req.on("error", (error) => reject(new Error(`Cannot reach GitLab at ${project.host}: ${(error as NodeJS.ErrnoException).code ?? error.message}`)));
    if (data) req.write(data);
    req.end();
  });
}

export interface MergeRequestInfo {
  title: string; description: string; webUrl: string; state: string;
  diffRefs: { baseSha: string; startSha: string; headSha: string } | null;
}
export async function mergeRequestInfo(call: GitLabCall, number: number): Promise<MergeRequestInfo> {
  const mr = await call("GET", `/merge_requests/${number}`);
  return {
    title: String(mr?.title ?? ""), description: String(mr?.description ?? ""), webUrl: String(mr?.web_url ?? ""), state: String(mr?.state ?? ""),
    diffRefs: mr?.diff_refs?.head_sha ? { baseSha: mr.diff_refs.base_sha, startSha: mr.diff_refs.start_sha, headSha: mr.diff_refs.head_sha } : null,
  };
}

type Finding = Reply["findings"][number];
export interface ReviewComment {
  finding: Finding;
  /** The same issue in a later review is not posted twice: severity aside, its place and words. */
  key: string;
  /** Repository-relative path and new-version line, when the evidence starts with a changed file's path:line. */
  location: { path: string; line: number } | null;
  body: string;
}
const key = (f: Finding, location: ReviewComment["location"]) =>
  `${location ? `${location.path}:${location.line}` : "-"}|${f.description.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 300)}`;

/**
 * The assessed review's findings worth posting: not disputed by the main agent, not mere notes.
 * `prefix` is the project's folder inside the repository (a monorepo sub-project), since GitLab
 * paths start at the repository root.
 */
export function reviewComments(s: Session, r: Round, prefix: string, agent: string | null): ReviewComment[] {
  ensure(r.review?.kind === "code" && r.review.revision && r.reply, "That round is not a merge request review with a reply");
  const disputed = new Set((r.dispositions ?? []).filter((d) => d.disposition === "disputed").map((d) => d.findingId));
  const changed = new Set(r.review.revision.changedPaths);
  const footer = `\n\n<sub>Found by an independent ${agent ? `${agent} ` : ""}review in WAICC and checked by the main agent; reviewed at ${r.review.revision.to.slice(0, 10)}.</sub>`;
  return r.reply.findings.filter((f) => !disputed.has(f.id) && f.severity !== "info").map((f) => {
    const m = /^`?([^\s`:]+):(\d+)(?:[-–]\d+)?`?\s*[,;:.)\-–—]?\s*/.exec(f.evidence.trim());
    const location = m && changed.has(m[1]) ? { path: `${prefix}${m[1]}`, line: Number(m[2]) } : null;
    const evidence = (location ? f.evidence.trim().slice(m![0].length) : f.evidence.trim()) || f.evidence.trim();
    const body = `**${f.severity.toUpperCase()}: ${f.description.trim()}**\n\n${evidence}${f.suggestedFix ? `\n\n**Suggested fix:** ${f.suggestedFix.trim()}` : ""}${footer}`;
    return { finding: f, key: key(f, location), location, body };
  });
}

const rank = (c: ReviewComment) => ["critical", "high", "medium", "low", "info"].indexOf(c.finding.severity);
/** One note for the whole review: its outcome, what was posted on lines, and everything else in full, worst first. */
export function summaryNote(s: Session, r: Round, inline: ReviewComment[], general: ReviewComment[], disputedCount: number): string {
  const rev = r.review?.kind === "code" ? r.review.revision! : null;
  const counts = [...inline, ...general].reduce<Record<string, number>>((n, c) => ({ ...n, [c.finding.severity]: (n[c.finding.severity] ?? 0) + 1 }), {});
  const order = ["critical", "high", "medium", "low"].filter((sev) => counts[sev]).map((sev) => `${counts[sev]} ${sev}`).join(", ");
  return [
    `### WAICC review${rev ? ` of ${rev.range} at ${rev.to.slice(0, 10)}` : ""}`,
    "",
    r.reply?.summary?.trim() ?? "",
    "",
    inline.length + general.length ? `**${inline.length + general.length} finding${inline.length + general.length === 1 ? "" : "s"}** (${order}).` : "**No issues to report.**",
    inline.length ? `${inline.length} ${inline.length === 1 ? "is" : "are"} commented on ${inline.length === 1 ? "its line" : "their lines"}.` : "",
    disputedCount ? `${disputedCount} other finding${disputedCount === 1 ? " was" : "s were"} checked and set aside as not a real problem.` : "",
    ...(general.length ? ["", ...[...general].sort((a, b) => rank(a) - rank(b)).map((c) => `- ${c.body.replace(/\n\n<sub>[\s\S]*<\/sub>$/, "").replace(/\n+/g, " ")}`)] : []),
    "",
    "<sub>Posted from WAICC after the reviewer's findings were checked by the main agent and confirmed by a person.</sub>",
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n").trim();
}
