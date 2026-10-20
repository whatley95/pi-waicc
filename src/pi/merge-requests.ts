import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { listSessions, loadSession } from "../files.ts";
import { gitlabClient, gitlabProject, mergeRequestInfo, openMergeRequests, reviewComments, summaryNote, type GitLabProject, type ReviewComment } from "../gitlab.ts";
import { gitlabHost, userConfigPath } from "../profiles.ts";
import { chooseRemote, remoteMergeRequests, repositoryPrefix } from "../revision.ts";
import { projectRoot } from "../source.ts";
import { postedComments, recordPostedComments, type PostedComments } from "../workflow.ts";
import { ensure } from "../validation.ts";
import type { App } from "./app.ts";

const short = (sha: string) => sha.slice(0, 10);
const oneLine = (text: string, max = 110) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

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
  const host = project ? gitlabHost(ctx.cwd, project.host) : null;
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
    title = `The newest ${refs.length} merge request numbers on ${remote}. Without a GitLab token git cannot tell open from merged ones or show titles; set up "gitlab" in your user file for that`;
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
      const project = gitlabProject(mr.url);
      const host = gitlabHost(ctx.cwd, project.host);
      ensure(host, `WAICC posts only to GitLab hosts listed in your user file. Add this to ${userConfigPath()}:\n"gitlab": { "${project.host}": { "tokenEnv": "GITLAB_TOKEN"${project.secure ? "" : `, "allowHttp": true`} } }\nthen set GITLAB_TOKEN to a personal access token with the "api" scope (or use "token": "<the token>").`);
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
