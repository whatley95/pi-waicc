import { execFileSync } from "node:child_process";
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

export type OriginProbe = (project: GitLabProject) => Promise<GitLabProject>;
const canonical = new Map<string, GitLabProject>();
/**
 * Where the GitLab server really answers. A remote may name an address that redirects
 * elsewhere, such as http://10.0.0.5 forwarding to https://gitlab.example.com. One request to the
 * public version endpoint, without any token, follows up to three redirects; the token is then
 * looked up, and sent, only for the host that answers. On any failure the remote's own address
 * stands, and the real request reports the problem.
 */
export const canonicalProject: OriginProbe = async (project) => {
  const known = canonical.get(project.origin);
  if (known) return { ...known, path: project.path };
  let url = new URL(`${project.origin}/api/v4/version`);
  for (let hop = 0; hop < 3; hop++) {
    const location = await new Promise<string | null>((resolve) => {
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = send(url, { method: "GET", timeout: 10_000, ...(url.protocol === "https:" && certificates() ? { ca: certificates() } : {}) }, (res) => {
        res.resume();
        resolve([301, 302, 307, 308].includes(res.statusCode ?? 0) ? String(res.headers.location ?? "") || null : null);
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
      req.end();
    });
    if (!location) break;
    const next = new URL(location, url);
    if (!["https:", "http:"].includes(next.protocol)) break;
    url = next;
  }
  const secure = url.protocol === "https:";
  const host = url.port && url.port !== (secure ? "443" : "80") ? `${url.hostname}:${url.port}` : url.hostname;
  const found = { origin: `${url.protocol}//${host}`, host, path: project.path, secure };
  canonical.set(project.origin, found);
  return found;
};

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
    // "/user" is the signed-in account, outside the project.
    const target = new URL(path === "/user" ? `${project.origin}/api/v4/user` : `${base}${path}`);
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
        // A job's log is plain text: that comes back as it is.
        if ((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300) return resolve(json ?? (text || null));
        // A redirect is not followed with your token; say where it points instead of showing its page.
        if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) {
          const error = new Error(`GitLab at ${project.host} redirected ${method} ${path.split("?")[0]} to ${String(res.headers.location ?? "another address").split("?")[0]}; WAICC does not send your token on to another address. List that host under "gitlab" in your user file, or point the remote at it.`) as Error & { status?: number };
          error.status = res.statusCode;
          return reject(error);
        }
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

/**
 * Saves a variable in the Windows user settings, as setx does, for programs started later. The
 * value goes to PowerShell through its environment, never on a command line others could see.
 */
export function saveWindowsUserVariable(name: string, value: string): boolean {
  if (process.platform !== "win32" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return false;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::SetEnvironmentVariable('${name}', $env:WAICC_SAVE_VALUE, 'User')`],
      { env: { ...process.env, WAICC_SAVE_VALUE: value }, windowsHide: true, timeout: 30_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** GitLab's page for a new personal access token, filled in with a name and the api scope. */
export const tokenPageUrl = (project: GitLabProject): string =>
  `${project.origin}/-/user_settings/personal_access_tokens?name=${encodeURIComponent("WAICC reviews")}&scopes=api`;

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

export interface OpenMergeRequest { number: number; title: string; author: string; source: string; target: string; updatedAt: string; draft: boolean; webUrl: string }
/** The project's open merge requests, most recently updated first. */
export async function openMergeRequests(call: GitLabCall, limit = 50): Promise<OpenMergeRequest[]> {
  const list = await call("GET", `/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=${limit}`);
  return (Array.isArray(list) ? list : []).map((mr: any) => ({
    number: Number(mr.iid), title: String(mr.title ?? ""), author: String(mr.author?.username ?? mr.author?.name ?? ""),
    source: String(mr.source_branch ?? ""), target: String(mr.target_branch ?? ""), updatedAt: String(mr.updated_at ?? ""),
    draft: Boolean(mr.draft ?? mr.work_in_progress), webUrl: String(mr.web_url ?? ""),
  })).filter((mr) => Number.isSafeInteger(mr.number) && mr.number > 0);
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
/** Every posted comment opens with this, so no reader takes an AI finding as a person's verified one. */
export const automatedNotice = "> 🤖 **Automated review by AI agents.** This may be a false alarm: check it against the code before acting on it.";
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
  const footer = `\n\n<sub>Found by an independent ${agent ? `${agent} ` : ""}AI review in WAICC, then checked by the main AI agent and picked for posting by a person; reviewed at ${r.review.revision.to.slice(0, 10)}.</sub>`;
  return r.reply.findings.filter((f) => !disputed.has(f.id) && f.severity !== "info").map((f) => {
    const m = /^`?([^\s`:]+):(\d+)(?:[-–]\d+)?`?\s*[,;:.)\-–—]?\s*/.exec(f.evidence.trim());
    const location = m && changed.has(m[1]) ? { path: `${prefix}${m[1]}`, line: Number(m[2]) } : null;
    const evidence = (location ? f.evidence.trim().slice(m![0].length) : f.evidence.trim()) || f.evidence.trim();
    const body = `${automatedNotice}\n\n**${f.severity.toUpperCase()}: ${f.description.trim()}**\n\n${evidence}${f.suggestedFix ? `\n\n**Suggested fix:** ${f.suggestedFix.trim()}` : ""}${footer}`;
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
    `### 🤖 Automated WAICC review${rev ? ` of ${rev.range} at ${rev.to.slice(0, 10)}` : ""}`,
    "",
    "> **These findings come from AI agents.** Any of them may be a false alarm: check each one against the code before changing anything.",
    "",
    r.reply?.summary?.trim() ?? "",
    "",
    inline.length + general.length ? `**${inline.length + general.length} finding${inline.length + general.length === 1 ? "" : "s"}** (${order}).` : "**No issues to report.**",
    inline.length ? `${inline.length} ${inline.length === 1 ? "is" : "are"} commented on ${inline.length === 1 ? "its line" : "their lines"}.` : "",
    disputedCount ? `${disputedCount} other finding${disputedCount === 1 ? " was" : "s were"} checked by the main agent and set aside as false alarms.` : "",
    ...(general.length ? ["", ...[...general].sort((a, b) => rank(a) - rank(b)).map((c) => `- ${c.body.replace(`${automatedNotice}\n\n`, "").replace(/\n\n<sub>[\s\S]*<\/sub>$/, "").replace(/\n+/g, " ")}`)] : []),
    "",
    "<sub>Posted from WAICC: an AI reviewer's findings, checked by the main AI agent and picked for posting by a person. Not a human code review.</sub>",
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n").trim();
}
