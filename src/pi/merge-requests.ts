import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listSessions, loadSession } from "../files.ts";
import { canonicalProject, gitlabClient, gitlabProject, mergeRequestInfo, openMergeRequests, reviewComments, saveWindowsUserVariable, summaryNote, tokenPageUrl, type GitLabHost, type GitLabProject, type ReviewComment } from "../gitlab.ts";
import { addGitlabHost, gitlabHost, userConfigPath } from "../profiles.ts";
import { chooseRemote, remoteMergeRequests, repositoryPrefix } from "../revision.ts";
import { projectRoot } from "../source.ts";
import { openPage } from "../tracker.ts";
import { postedComments, recordPostedComments, type PostedComments } from "../workflow.ts";
import { ensure } from "../validation.ts";
import type { App } from "./app.ts";

const short = (sha: string) => sha.slice(0, 10);
const oneLine = (text: string, max = 110) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// A token pasted during setup and not saved: kept in memory for this Pi session only. Never put in
// Pi's environment, so agents WAICC dispatches do not inherit it.
const sessionTokens = new Map<string, string>();
/** Forgets tokens pasted this session (tests start each case clean). */
export const forgetSessionTokens = (): void => sessionTokens.clear();
/** A listed host's settings, with a token pasted this session if the file or variable has none. */
export function resolveGitlabHost(cwd: string, host: string): GitLabHost | null {
  const listed = gitlabHost(cwd, host);
  return listed && !listed.token && sessionTokens.has(host.toLowerCase()) ? { ...listed, token: sessionTokens.get(host.toLowerCase())! } : listed;
}

/**
 * Guided setup for a GitLab host, step by step and only with your yes at each step: list the host
 * in your user file, open GitLab's token page, take the pasted token, check it with GitLab, then
 * keep it (a Windows user variable, or your user file elsewhere) or use it for this session only.
 * Returns the host's settings, or null when you stopped.
 */
async function setupGitlabHost(app: App, ctx: ExtensionCommandContext, project: GitLabProject): Promise<GitLabHost | null> {
  const { services } = app;
  const listed = gitlabHost(ctx.cwd, project.host);
  const manual = `WAICC posts only to GitLab hosts listed in your user file. Add this to ${userConfigPath()}:\n"gitlab": { "${project.host}": { "tokenEnv": "GITLAB_TOKEN"${project.secure ? "" : `, "allowHttp": true`} } }\nthen create a GitLab personal access token with the "api" scope and set it, in PowerShell: setx GITLAB_TOKEN "glpat-...", reopen the terminal and start Pi again.`;
  if (!listed && !(await ctx.ui.confirm(`Set up ${project.host} for posting? (step 1 of 3)`,
    `WAICC posts only to GitLab hosts in your user file (${userConfigPath()}). Add ${project.host} there? Next you create a token, and WAICC checks it with GitLab before posting anything.`))) {
    ctx.ui.notify(`Nothing was posted. ${manual}`, "info");
    return null;
  }
  if (!project.secure && !listed?.allowHttp && !(await ctx.ui.confirm("Send the token over plain http?",
    `${project.host} is reached over http, so your token would travel unencrypted. Allow that for this host? Say no unless the network is trusted.`))) {
    ctx.ui.notify(`Nothing was posted, and ${project.host} was not added: posting to it needs the token over plain http.`, "info");
    return null;
  }
  const allowHttp = !project.secure;
  const save = (options: { token?: string } = {}) => (listed ? null : addGitlabHost(project.host, { allowHttp, ...options }));
  if (!listed && process.env.GITLAB_TOKEN?.trim()) {
    save();
    return resolveGitlabHost(ctx.cwd, project.host);
  }

  const page = tokenPageUrl(project);
  if (await ctx.ui.confirm("Create a GitLab token (step 2 of 3)",
    `WAICC needs a personal access token with the "api" scope. Open GitLab's page for it in your browser? It comes filled in with the name "WAICC reviews" and the api scope: choose an expiry date, create it and copy it. If the page is not found, use your avatar → Preferences → Access tokens.`))
    (services.openPage ?? openPage)(page);
  const token = (await ctx.ui.input("Paste the token (it starts with glpat-). It is checked with GitLab and never shown in the chat.", "glpat-..."))?.trim();
  if (!token) {
    ctx.ui.notify(`Nothing was posted. When you have the token, run /waicc-mr-comments again (token page: ${page}).`, "info");
    return null;
  }
  if (!/^[A-Za-z0-9_.-]{8,200}$/.test(token)) {
    ctx.ui.notify("That does not look like a GitLab token, so nothing was saved or posted. Copy the whole token and run /waicc-mr-comments again.", "error");
    return null;
  }
  let username = "";
  try {
    const user = await (services.gitlab ?? gitlabClient)(project, { token, allowHttp })("GET", "/user");
    username = String(user?.username ?? "");
  } catch (error) {
    ctx.ui.notify(`GitLab did not accept that token (${error instanceof Error ? error.message : String(error)}), so nothing was saved or posted. Check it has the "api" scope and has not expired.`, "error");
    return null;
  }

  // Step 3: keep it for next time, or use it only in this Pi session.
  const windows = process.platform === "win32";
  const keep = await ctx.ui.confirm(`The token works${username ? `: signed in as @${username}` : ""} (step 3 of 3)`,
    windows
      ? "Keep it for next time as the GITLAB_TOKEN variable in your Windows user settings (what setx does)? Programs you start later can read it. Without it, it works in this Pi session and you paste it again after a restart."
      : `Keep it for next time in your user file (${userConfigPath()}), readable only by you? Without it, it works in this Pi session; to keep it yourself, add export GITLAB_TOKEN="…" to your shell profile.`);
  let saved = false;
  if (keep && windows) saved = (services.saveUserVariable ?? saveWindowsUserVariable)("GITLAB_TOKEN", token);
  const added = save(keep && !windows ? { token } : {});
  if (!(keep && !windows)) sessionTokens.set(project.host.toLowerCase(), token);
  ctx.ui.notify(`${added ? `Added ${project.host} to ${added.path}. ` : ""}${keep ? (windows ? (saved ? "Saved GITLAB_TOKEN in your Windows user settings; new terminals will have it." : "Could not save GITLAB_TOKEN in your Windows settings; it works for this Pi session.") : "Saved the token in your user file.") : "The token works for this Pi session only."}`, "info");
  return resolveGitlabHost(ctx.cwd, project.host);
}

const ago = (iso: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return Number.isNaN(minutes) ? "" : minutes < 60 ? `${minutes}m ago` : minutes < 2880 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};

/**
 * /waicc-review --mr --list: the merge requests to pick one to review from. With the GitLab host
 * set up, the open ones with title, author and branches; without a token, git can only list the
 * newest numbers, open or not. Each is marked when a WAICC session here already reviews it.
 * Returns the chosen number, or null.
 */
export async function pickMergeRequest(app: App, ctx: ExtensionCommandContext, wanted?: string): Promise<string | null> {
  const { pi, services } = app;
  const root = projectRoot(ctx.cwd);
  const { remote, url, provider } = chooseRemote(root, wanted);
  const reviewed = new Map<number, string>();
  for (const summary of listSessions(root))
    try {
      const s = loadSession(root, summary.id);
      const m = s.revisionReview?.mergeRequest;
      if (m && m.remote === remote) reviewed.set(m.number, s.status === "CLOSED" ? "reviewed, closed" : `in review: ${s.status.toLowerCase().replaceAll("_", " ")}`);
    } catch { /* an unreadable session is skipped */ }
  const mark = (n: number) => (reviewed.has(n) ? ` · ${reviewed.get(n)}` : "");
  const sign = provider === "github" ? "#" : "!";
  let project: GitLabProject | null = null;
  try {
    project = provider === "gitlab" && url ? gitlabProject(url) : null;
  } catch { /* an unusual remote URL: list with git only */ }
  // The server's real address, which a remote's http address may only redirect to.
  if (project) project = await (services.gitlabOrigin ?? canonicalProject)(project);
  let host = project ? resolveGitlabHost(ctx.cwd, project.host) : null;
  // GITLAB_TOKEN is there but the host is not listed: with your yes, list it and use the token.
  if (project && !host && ctx.hasUI && process.env.GITLAB_TOKEN?.trim()
    && (project.secure || await ctx.ui.confirm("Send the token over plain http?", `${project.host} is reached over http, so your token would travel unencrypted. Allow that for this host?`))
    && await ctx.ui.confirm(`Use your GitLab token for ${project.host}?`,
      `GITLAB_TOKEN is set, but ${project.host} is not listed under "gitlab" in your user file (${userConfigPath()}), and WAICC sends the token only to hosts listed there. Add ${project.host}, reading the token from GITLAB_TOKEN? Then this list shows the open merge requests with their titles.`)) {
    addGitlabHost(project.host, { allowHttp: !project.secure });
    host = resolveGitlabHost(ctx.cwd, project.host);
  }
  // Why the list is numbers only, in words that say what to do.
  const missing = !project ? "this remote is not a GitLab project WAICC can read"
    : !host ? `${project.host} is not listed under "gitlab" in your user file${process.env.GITLAB_TOKEN?.trim() ? "" : " and GITLAB_TOKEN is not set in this Pi"} (/waicc-mr-comments walks you through it)`
      : `no token for ${project.host} in this Pi (if you just ran setx, restart the terminal and Pi)`;
  let rows: { number: number; label: string }[], title: string;
  ctx.ui.notify(`Listing merge requests on ${remote}…`, "info");
  if (project && host?.token) {
    const open = await openMergeRequests((services.gitlab ?? gitlabClient)(project, host));
    rows = open.map((mr) => ({
      number: mr.number,
      label: `!${mr.number} ${mr.draft ? "[draft] " : ""}${oneLine(mr.title, 60)} · ${mr.author} · ${mr.source} → ${mr.target} · ${ago(mr.updatedAt)}${mark(mr.number)}`,
    }));
    title = `${open.length} open merge request${open.length === 1 ? "" : "s"} on ${project.path}: pick one to review`;
  } else {
    const refs = await remoteMergeRequests(root, remote);
    rows = refs.map((r) => ({ number: r.number, label: `${sign}${r.number} · head ${short(r.head)}${mark(r.number)}` }));
    title = `The newest ${refs.length} merge request numbers on ${remote}, open or merged: no titles because ${missing}`;
  }
  ensure(rows.length, `${remote} has no ${provider === "github" ? "open pull" : "open merge"} requests`);
  if (!ctx.hasUI) {
    pi.sendMessage({ customType: "waicc-merge-requests", content: [title, ...rows.map((r) => `- ${r.label}`)].join("\n"), display: true }, { triggerTurn: false });
    return null;
  }
  const picked = await ctx.ui.select(title, [...rows.map((r) => r.label), "Cancel"]);
  return rows.find((r) => r.label === picked)?.number.toString() ?? null;
}

/**
 * /waicc-mr-comments: posts the assessed merge request review to GitLab, as comments on the
 * findings' lines and one summary, only after the human picks what to post and confirms.
 * The main agent never posts: this is a command, not a tool.
 */
export function registerMergeRequestCommands(app: App): void {
  const { pi, services, selected, command } = app;
  command(
    "waicc-mr-comments",
    "Post the assessed merge request review to GitLab: comments on the findings' lines and a summary, after you choose and confirm",
    async (_args, ctx) => {
      ensure(ctx.hasUI, "Posting to a merge request needs your confirmation in Pi's interactive screen");
      const id = selected(ctx);
      const root = projectRoot(ctx.cwd);
      const s = loadSession(root, id);
      const mr = s.revisionReview?.mergeRequest;
      ensure(mr, "This session is not a merge request review; start one with /waicc-review --mr <number>");
      ensure(mr.provider === "gitlab", "Posting is supported for GitLab merge requests; GitHub pull requests are not yet");
      const round = s.rounds.findLast((r) => r.review?.kind === "code" && r.status === "ASSESSED" && r.reply);
      ensure(round?.review?.kind === "code" && round.review.revision,
        "No assessed review to post yet: /waicc-dispatch the review, then /waicc-continue so the main agent checks its findings");
      ensure(mr.url, "The merge request's remote URL was not recorded; fetch it again with /waicc-review --mr");
      const project = await (services.gitlabOrigin ?? canonicalProject)(gitlabProject(mr.url));
      const host = resolveGitlabHost(ctx.cwd, project.host)?.token ? resolveGitlabHost(ctx.cwd, project.host)! : await setupGitlabHost(app, ctx, project);
      if (!host) return;
      const call = (services.gitlab ?? gitlabClient)(project, host);
      const info = await mergeRequestInfo(call, mr.number);
      const reviewed = round.review.revision.to;
      // Line comments are placed against the reviewed version; a newer one would misplace them.
      ensure(info.diffRefs?.headSha === reviewed,
        `Merge request !${mr.number} has changed since this review (it is at ${short(info.diffRefs?.headSha ?? "unknown")}, the review saw ${short(reviewed)}). Run /waicc-review --mr ${mr.number} to fetch it and review again before posting.`);
      ensure(info.state === "opened", `Merge request !${mr.number} is ${info.state || "not open"}; nothing was posted`);

      const all = reviewComments(s, round, repositoryPrefix(root), null);
      const already = new Set(postedComments(ctx.cwd, id).flatMap((p) => p.comments.map((c) => c.key)));
      const fresh = all.filter((c) => !already.has(c.key));
      const disputed = (round.dispositions ?? []).filter((d) => d.disposition === "disputed").length;
      const skipped = all.length - fresh.length;
      const onLines = fresh.filter((c) => c.location).length;
      let chosen: ReviewComment[] = [];
      const options = fresh.length
        ? [`Post all ${fresh.length} finding${fresh.length === 1 ? "" : "s"} (${onLines} on their lines) and a summary`, "Choose findings one by one", "Post only a summary", "Cancel"]
        : ["Post a summary saying no new issues were found", "Cancel"];
      const picked = await ctx.ui.select(
        `Merge request !${mr.number}: ${oneLine(info.title, 70)} · ${fresh.length} finding${fresh.length === 1 ? "" : "s"} to post${skipped ? ` · ${skipped} already posted` : ""}${disputed ? ` · ${disputed} set aside by the main agent` : ""}`,
        options,
      );
      if (!picked || picked === "Cancel") return ctx.ui.notify("Nothing was posted.", "info");
      if (picked.startsWith("Post all")) chosen = fresh;
      else if (picked.startsWith("Choose"))
        for (const c of fresh)
          if (await ctx.ui.confirm(`${c.finding.severity.toUpperCase()} ${c.finding.id}: ${oneLine(c.finding.description, 90)}`,
            `${c.location ? `On ${c.location.path}:${c.location.line}` : "In the summary (not on a changed line)"}\n\n${oneLine(c.finding.evidence, 400)}\n\nPost this finding?`)) chosen.push(c);
      const inline = chosen.filter((c) => c.location);
      const total = `${chosen.length ? `${chosen.length} finding${chosen.length === 1 ? "" : "s"} (${inline.length} on their lines) and ` : ""}a summary`;
      if (!(await ctx.ui.confirm(`Post to merge request !${mr.number}?`, `${total} to ${info.webUrl || `${project.origin}/${project.path}`}. Everyone on the merge request will see them, and WAICC cannot take them back.`)))
        return ctx.ui.notify("Nothing was posted.", "info");

      const posted: PostedComments["comments"] = [];
      const general = chosen.filter((c) => !c.location);
      let failure: string | null = null;
      for (const c of inline) {
        try {
          const discussion = await call("POST", `/merge_requests/${mr.number}/discussions`, {
            body: c.body,
            position: { position_type: "text", base_sha: info.diffRefs!.baseSha, start_sha: info.diffRefs!.startSha, head_sha: info.diffRefs!.headSha, new_path: c.location!.path, new_line: c.location!.line },
          });
          posted.push({ findingId: c.finding.id, key: c.key, inline: true, noteId: discussion?.notes?.[0]?.id ?? null });
        } catch (error) {
          // A line GitLab cannot place a comment on (not part of the diff) goes into the summary.
          if ((error as { status?: number }).status === 400) general.push(c);
          else { failure = error instanceof Error ? error.message : String(error); break; }
        }
      }
      let summaryNoteId: number | null = null;
      if (!failure)
        try {
          const note = await call("POST", `/merge_requests/${mr.number}/notes`, { body: summaryNote(s, round, chosen.filter((c) => !general.includes(c)), general, disputed) });
          summaryNoteId = note?.id ?? null;
          for (const c of general) posted.push({ findingId: c.finding.id, key: c.key, inline: false, noteId: summaryNoteId });
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      // Whatever reached GitLab is recorded, even when a later post failed, so it is never repeated.
      if (posted.length || summaryNoteId !== null)
        recordPostedComments(ctx.cwd, id, { postedAt: new Date().toISOString(), requestId: round.id, headSha: reviewed, webUrl: info.webUrl, comments: posted, summaryNoteId });
      const done = `${posted.filter((p) => p.inline).length} line comment${posted.filter((p) => p.inline).length === 1 ? "" : "s"}${summaryNoteId !== null ? " and a summary" : ""}`;
      if (failure) {
        ctx.ui.notify(`Posted ${done} to merge request !${mr.number}, then stopped: ${failure}`, "error");
        return;
      }
      ctx.ui.notify(`Posted ${done} to merge request !${mr.number}: ${info.webUrl}`, "info");
      pi.sendMessage({ customType: "waicc-mr-comments", content: `Posted ${done} to ${info.webUrl}.`, display: true }, { triggerTurn: false });
    },
  );
}
