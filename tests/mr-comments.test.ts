import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import waicc from "../src/index.ts";
import { automatedNotice, canonicalProject, gitlabClient, gitlabProject, reviewComments, summaryNote, type GitLabCall } from "../src/gitlab.ts";
import { addGitlabHost, gitlabHost, loadAgentConfig, profilesView } from "../src/profiles.ts";
import { forgetSessionTokens } from "../src/pi/merge-requests.ts";
import { mergeRequestUrl, projectStatus } from "../src/tracker.ts";
import { runInNewContext } from "node:vm";
import { receiveHandoff, submitRecipientReply } from "../src/recipient.ts";
import { resolveRevision } from "../src/revision.ts";
import { assess, createRevisionReview, ingest, postedComments, prepare } from "../src/workflow.ts";
import type { Contract } from "../src/types.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

/** A merge request review that the main agent has assessed: one finding on a line, one general, one disputed, one note. */
function assessedReview(t: TestContext) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "waicc-test-")));
  const agentDir = join(base, "agent"), root = join(base, "repo");
  mkdirSync(agentDir);
  mkdirSync(join(root, "services", "status"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.env.PI_CODING_AGENT_DIR = previous;
    assert.ok(basename(base).startsWith("waicc-test-"));
    rmSync(base, { recursive: true, force: true });
  });
  git(root, "init", "-q", "-b", "develop");
  writeFileSync(join(root, "services", "status", "app.js"), "export const status = 1;\n");
  writeFileSync(join(root, "README.md"), "app\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Start");
  writeFileSync(join(root, "services", "status", "app.js"), "export const status = 2;\nexport function sync(x) { return x.id; }\n");
  git(root, "commit", "-q", "-am", "Add sync");
  const range = resolveRevision(root, "HEAD", "git");
  const s = createRevisionReview(root, { ...range, range: "!7", mergeRequest: { remote: "origin", number: 7, provider: "gitlab", target: "develop", url: "https://gitlab.example.com/team/app.git", head: range.to } }, "Check sync");
  const contract: Contract = {
    title: "MR !7", requirements: [{ id: "R1", text: "Sync works", sourceQuote: s.requirements[0] }],
    exclusions: [], assumptions: [], questions: [], risks: [], skills: [],
    tasks: [{ id: "T1", title: "Status service", requirementIds: ["R1"], dependsOn: [], allowedPaths: ["services/status/app.js"],
      acceptance: [{ id: "AC1", text: "Sync", requirementIds: ["R1"], verification: "Read it" }] }],
  };
  prepare(root, s.id, contract, "review", "Review it", 0, { kind: "code", completion: {
    summary: "Adds sync", tasks: [{ taskId: "T1", evidence: "services/status/app.js" }],
    checks: [{ description: "Tests", outcome: "not_run", evidence: "None in this repo" }], findings: [] } });
  submitRecipientReply(root, receiveHandoff(root, s.id).pin, {
    outcome: "needs_changes", summary: "sync() crashes on null input.", questions: [],
    findings: [
      { id: "F1", severity: "high", description: "sync() throws when x is null", evidence: "services/status/app.js:2 — x.id is read without a check", suggestedFix: "Return null when x is null" },
      { id: "F2", severity: "medium", description: "No test covers sync()", evidence: "The MR adds no test file" },
      { id: "F3", severity: "low", description: "Rename status to state", evidence: "services/status/app.js:1 naming" },
      { id: "F4", severity: "info", description: "Nice and small", evidence: "Whole MR" },
    ],
    coverage: [{ requirementId: "R1", status: "addressed", evidence: "services/status/app.js" }],
    checks: [{ description: "Read the patch", outcome: "passed", evidence: "changes.patch" }],
  });
  const requestId = ingest(root, s.id).rounds.at(-1)!.id;
  const assessed = assess(root, s.id, { requestId, decision: "needs_changes", rationale: "F1 and F2 are real",
    dispositions: [{ findingId: "F3", disposition: "disputed", evidence: "The name matches the service" }] });
  return { base, agentDir, root, s: assessed, head: range.to, start: range.from };
}

test("the GitLab project comes from the remote URL: https, http, or SSH", () => {
  assert.deepEqual(gitlabProject("https://gitlab.example.com/team/mobile-app"), { origin: "https://gitlab.example.com", host: "gitlab.example.com", path: "team/mobile-app", secure: true });
  assert.deepEqual(gitlabProject("http://10.0.0.5/group/platform/services.git"), { origin: "http://10.0.0.5", host: "10.0.0.5", path: "group/platform/services", secure: false });
  assert.deepEqual(gitlabProject("git@gitlab.example.com:group/sub/app.git").path, "group/sub/app");
  assert.equal(gitlabProject("ssh://git@gitlab.example.com:2222/group/app.git").origin, "https://gitlab.example.com", "an SSH port is not the web server's");
  assert.equal(gitlabProject("https://gitlab.example.com:8443/group/app.git").host, "gitlab.example.com:8443");
  assert.throws(() => gitlabProject("/srv/git/app.git"), /Cannot tell the GitLab server/);
  assert.throws(() => gitlabProject("https://gitlab.example.com/app"), /Cannot tell the GitLab project/);
});

test("GitLab hosts and tokens are set in your user file only, and --profiles never shows a token", (t) => {
  const { agentDir, root } = assessedReview(t);
  assert.equal(gitlabHost(root, "gitlab.example.com"), null, "a host you have not listed gets no token");
  writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ gitlab: { "gitlab.example.com": { token: "glpat-secret-1" }, "10.0.0.5": { tokenEnv: "WAICC_TEST_TOKEN", allowHttp: true } } }));
  assert.deepEqual(gitlabHost(root, "GitLab.Example.com"), { token: "glpat-secret-1", allowHttp: false });
  assert.deepEqual(gitlabHost(root, "10.0.0.5"), { token: null, allowHttp: true }, "the variable is not set");
  process.env.WAICC_TEST_TOKEN = "glpat-from-env";
  t.after(() => { delete process.env.WAICC_TEST_TOKEN; });
  assert.equal(gitlabHost(root, "10.0.0.5")!.token, "glpat-from-env");
  const shown = JSON.stringify(profilesView(root));
  assert.ok(!shown.includes("glpat"), "no token in --profiles");
  assert.match(shown, /"gitlab\.example\.com":\{"token":"set in your user file"/);
  for (const [gitlab, message] of [
    [{ "gitlab.example.com": {} }, /needs "token" or "tokenEnv"/],
    [{ "https://gitlab.example.com": { token: "glpat-12345" } }, /hosts are names like/],
    [{ "gitlab.example.com": { token: "glpat-12345", url: "x" } }, /takes only "token", "tokenEnv" and "allowHttp"/],
    [{ "gitlab.example.com": { tokenEnv: "1BAD" } }, /must be an environment variable name/],
  ] as const) {
    writeFileSync(join(agentDir, "waicc-agents.json"), JSON.stringify({ gitlab }));
    assert.throws(() => loadAgentConfig(root), message);
  }
  writeFileSync(join(agentDir, "waicc-agents.json"), "{}");
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "waicc-agents.json"), JSON.stringify({ gitlab: { "evil.example.com": { token: "glpat-12345" } } }));
  assert.throws(() => loadAgentConfig(root), /"gitlab" is allowed only in your user file/, "a repository cannot point your token at its own server");
});

test("findings become comments on their lines or in the summary; disputed findings and notes are never posted", (t) => {
  const { s } = assessedReview(t);
  const round = s.rounds.at(-1)!;
  const comments = reviewComments(s, round, "", "codex");
  assert.deepEqual(comments.map((c) => [c.finding.id, c.location]), [["F1", { path: "services/status/app.js", line: 2 }], ["F2", null]]);
  // Every comment says first that it is an AI finding that may be a false alarm.
  for (const c of comments) assert.ok(c.body.startsWith(`${automatedNotice}\n\n**`), c.body);
  assert.match(automatedNotice, /Automated review by AI agents\.\*\* This may be a false alarm: check it against the code/);
  assert.match(comments[0].body, /\*\*HIGH: sync\(\) throws when x is null\*\*\n\nx\.id is read without a check\n\n\*\*Suggested fix:\*\* Return null when x is null/);
  assert.match(comments[0].body, /independent codex AI review in WAICC, then checked by the main AI agent and picked for posting by a person/);
  assert.equal(reviewComments(s, round, "monorepo/", null)[0].location!.path, "monorepo/services/status/app.js", "paths start at the repository root");
  const note = summaryNote(s, round, [comments[0]], [comments[1]], 1);
  assert.match(note, /^### 🤖 Automated WAICC review of !7 at [0-9a-f]+\n\n> \*\*These findings come from AI agents\.\*\* Any of them may be a false alarm/);
  assert.match(note, /\*\*2 findings\*\* \(1 high, 1 medium\)\./);
  assert.match(note, /1 is commented on its line\./);
  assert.match(note, /1 other finding was checked by the main agent and set aside as false alarms\./);
  assert.match(note, /- \*\*MEDIUM: No test covers sync\(\)\*\*/);
  assert.equal(note.split("Automated review by AI agents").length, 1, "the summary's warning is said once, not per finding");
  assert.match(note, /Not a human code review\.<\/sub>$/);
  assert.doesNotMatch(note, /Rename status|Nice and small/);
});

/** The extension with a fake GitLab that records every call, and a Pi screen that answers as told. */
async function run(t: TestContext, answers: { select: (options: string[]) => string; confirm?: boolean[]; input?: string[]; hasUI?: boolean }, gitlab: Partial<Record<string, (body: any) => any>> = {}) {
  forgetSessionTokens();
  const review = assessedReview(t);
  const calls: [string, string, any][] = [], notices: string[] = [], opened: string[] = [], saved: [string, string][] = [];
  const fake = (): GitLabCall => async (method, path, body) => {
    calls.push([method, path, body]);
    const handler = gitlab[`${method} ${path}`];
    if (handler) return handler(body);
    if (path === "/user") return { username: "whatley" };
    if (method === "GET") return { title: "Add sync", description: "Adds sync()", web_url: "https://gitlab.example.com/team/app/-/merge_requests/7", state: "opened", diff_refs: { base_sha: review.start, start_sha: review.start, head_sha: review.head } };
    return path.endsWith("/discussions") ? { id: "d1", notes: [{ id: 11 }] } : { id: 99 };
  };
  const commands = new Map<string, any>();
  waicc({
    registerCommand: (name: string, c: any) => commands.set(name, c), registerTool() {}, on() {}, appendEntry() {},
    getAllTools: () => [], getActiveTools: () => [], setActiveTools() {}, sendMessage() {}, sendUserMessage() {},
  } as unknown as ExtensionAPI, {
    gitlab: fake, gitlabOrigin: async (project) => project, openPage: (url) => (opened.push(url), true), saveUserVariable: (name, value) => (saved.push([name, value]), true),
  });
  const confirms = [...(answers.confirm ?? [])], inputs = [...(answers.input ?? [])];
  const ctx = {
    cwd: review.root, mode: "tui", hasUI: answers.hasUI ?? true, isIdle: () => true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "mr-chat", getBranch: () => [] },
    ui: {
      notify: (m: string) => notices.push(m), select: async (_title: string, options: string[]) => answers.select(options),
      confirm: async () => confirms.shift() ?? true, input: async () => inputs.shift(),
    },
  } as unknown as ExtensionCommandContext;
  await commands.get("waicc-use").handler(review.s.id, ctx);
  writeFileSync(join(review.agentDir, "waicc-agents.json"), JSON.stringify({ gitlab: { "gitlab.example.com": { token: "glpat-secret-1" } } }));
  const post = () => commands.get("waicc-mr-comments").handler("", ctx).catch((e: Error) => notices.push(`error: ${e.message}`));
  return { ...review, calls, notices, opened, saved, post };
}

test("after you pick and confirm, findings go on their lines and the rest into one summary, and nothing is posted twice", async (t) => {
  const h = await run(t, { select: (options) => options[0] });
  await h.post();
  const posts = h.calls.filter(([method]) => method === "POST");
  assert.deepEqual(posts.map(([, path]) => path), ["/merge_requests/7/discussions", "/merge_requests/7/notes"]);
  assert.deepEqual(posts[0][2].position, { position_type: "text", base_sha: h.start, start_sha: h.start, head_sha: h.head, new_path: "services/status/app.js", new_line: 2 });
  assert.match(posts[1][2].body, /No test covers sync\(\)/);
  assert.match(h.notices.at(-1)!, /^Posted 1 line comment and a summary to merge request !7: https:\/\/gitlab\.example\.com/);
  const record = postedComments(h.root, h.s.id);
  assert.deepEqual(record[0].comments.map((c) => [c.findingId, c.inline, c.noteId]), [["F1", true, 11], ["F2", false, 99]]);
  assert.equal(record[0].headSha, h.head);
});

test("re-posting is offered nothing new; a line GitLab rejects goes into the summary; cancelling posts nothing", async (t) => {
  let offered: string[] = [];
  const h = await run(t, { select: (options) => (offered = options, options[0]) }, {
    "POST /merge_requests/7/discussions": () => { throw Object.assign(new Error("line_code can't be blank"), { status: 400 }); },
  });
  await h.post();
  const posts = h.calls.filter(([method]) => method === "POST");
  assert.deepEqual(posts.map(([, path]) => path), ["/merge_requests/7/discussions", "/merge_requests/7/notes"]);
  assert.match(posts[1][2].body, /sync\(\) throws when x is null[\s\S]*No test covers sync\(\)/, "the rejected line comment is in the summary instead");
  assert.match(h.notices.at(-1)!, /^Posted 0 line comments and a summary/);
  const before = h.calls.length;
  await h.post();
  assert.deepEqual(offered, ["Post a summary saying no new issues were found", "Cancel"], "what was posted is never offered again");
  assert.equal(h.calls.filter(([method]) => method === "POST").length, 2 + 1, "only the new summary");
  assert.ok(h.calls.length > before);

  const cancel = await run(t, { select: (options) => options[0], confirm: [false] });
  await cancel.post();
  assert.equal(cancel.calls.filter(([method]) => method === "POST").length, 0, "the final confirmation said no");
  assert.equal(cancel.notices.at(-1), "Nothing was posted.");
});

test("nothing is posted for a changed merge request, an unlisted host or without the interactive screen", async (t) => {
  const moved = await run(t, { select: (options) => options[0] }, {
    "GET /merge_requests/7": () => ({ title: "x", web_url: "u", state: "opened", diff_refs: { base_sha: "a", start_sha: "a", head_sha: "ffffffffffffffffffffffffffffffffffffffff" } }),
  });
  await moved.post();
  assert.match(moved.notices.at(-1)!, /has changed since this review \(it is at ffffffffff, the review saw [0-9a-f]{10}\)\. Run \/waicc-review --mr 7/);
  assert.equal(moved.calls.filter(([method]) => method === "POST").length, 0);

  const unlisted = await run(t, { select: (options) => options[0], confirm: [false] });
  writeFileSync(join(unlisted.agentDir, "waicc-agents.json"), "{}");
  await unlisted.post();
  assert.match(unlisted.notices.at(-1)!, /^Nothing was posted\. WAICC posts only to GitLab hosts listed in your user file[\s\S]*"gitlab": \{ "gitlab\.example\.com": \{ "tokenEnv": "GITLAB_TOKEN" \} \}/);
  assert.equal(unlisted.calls.length, 0, "not even a read");
  assert.equal(readFileSync(join(unlisted.agentDir, "waicc-agents.json"), "utf8"), "{}", "you said no: the file is unchanged");

  const headless = await run(t, { select: (options) => options[0], hasUI: false });
  await headless.post();
  assert.match(headless.notices.at(-1)!, /needs your confirmation in Pi's interactive screen/);
  assert.equal(headless.calls.length, 0);
});

test("guided setup: list the host, open the token page, check the pasted token with GitLab, keep it, then post in the same run", async (t) => {
  delete process.env.GITLAB_TOKEN;
  // Answers: add the host, open the page, keep the token, then post all and confirm.
  const h = await run(t, { select: (options) => options[0], confirm: [true, true, true, true], input: ["glpat-pasted-12345"] });
  const file = join(h.agentDir, "waicc-agents.json");
  writeFileSync(file, JSON.stringify({ roles: { review: "sol" }, profiles: { sol: { via: "codex", model: "gpt-6.1-sol" } } }));
  await h.post();
  assert.deepEqual(h.opened, ["https://gitlab.example.com/-/user_settings/personal_access_tokens?name=WAICC%20reviews&scopes=api"], "the page comes filled in");
  assert.equal(h.calls[0][1], "/user", "the token is checked with GitLab before anything else");
  const config = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(config.roles, { review: "sol" }, "everything else in the file is kept");
  if (process.platform === "win32") {
    assert.deepEqual(h.saved, [["GITLAB_TOKEN", "glpat-pasted-12345"]], "kept as a Windows user variable");
    assert.deepEqual(config.gitlab, { "gitlab.example.com": { tokenEnv: "GITLAB_TOKEN" } }, "the file names the variable, not the token");
  } else assert.deepEqual(config.gitlab, { "gitlab.example.com": { token: "glpat-pasted-12345" } }, "kept in the user file, readable only by you");
  assert.equal(process.env.GITLAB_TOKEN, undefined, "never put in Pi's own environment, which dispatched agents inherit");
  assert.equal(h.calls.filter(([method]) => method === "POST").length, 2, "and the review is posted in the same run");
  assert.ok(h.notices.some((n) => /^Added gitlab\.example\.com to /.test(n)));
  assert.ok(!h.notices.join("\n").includes("glpat-pasted"), "the token is never shown");

  assert.throws(() => addGitlabHost("GitLab.Example.com"), /already under "gitlab"/, "a host there is never replaced");
  const added = addGitlabHost("10.0.0.5", { allowHttp: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).gitlab["10.0.0.5"], { tokenEnv: "GITLAB_TOKEN", allowHttp: true });
  assert.equal(added.tokenSet, false, "GITLAB_TOKEN is not set here");
  writeFileSync(file, "{ not json");
  assert.throws(() => addGitlabHost("other.example.com"), /is not valid JSON, so it was left unchanged/);
  assert.equal(readFileSync(file, "utf8"), "{ not json");
});

test("guided setup: a token GitLab refuses saves nothing; one kept only for this session still posts", async (t) => {
  delete process.env.GITLAB_TOKEN;
  const refused = await run(t, { select: (options) => options[0], confirm: [true, false], input: ["glpat-wrong-12345"] }, {
    "GET /user": () => { throw Object.assign(new Error("GitLab GET /user failed (HTTP 401): 401 Unauthorized"), { status: 401 }); },
  });
  writeFileSync(join(refused.agentDir, "waicc-agents.json"), "{}");
  await refused.post();
  assert.match(refused.notices.at(-1)!, /^GitLab did not accept that token \(GitLab GET \/user failed \(HTTP 401\)[\s\S]*nothing was saved or posted/);
  assert.equal(readFileSync(join(refused.agentDir, "waicc-agents.json"), "utf8"), "{}");
  assert.deepEqual(refused.opened, [], "you said no to opening the page");

  // Kept for this session only: the file names the variable, and posting still works now.
  const once = await run(t, { select: (options) => options[0], confirm: [true, false, false, true], input: ["glpat-session-1234"] });
  writeFileSync(join(once.agentDir, "waicc-agents.json"), "{}");
  await once.post();
  assert.deepEqual(once.saved, []);
  assert.deepEqual(JSON.parse(readFileSync(join(once.agentDir, "waicc-agents.json"), "utf8")).gitlab, { "gitlab.example.com": { tokenEnv: "GITLAB_TOKEN" } });
  assert.ok(once.notices.some((n) => /The token works for this Pi session only/.test(n)));
  assert.equal(once.calls.filter(([method]) => method === "POST").length, 2);

  const empty = await run(t, { select: (options) => options[0], confirm: [true, false], input: [""] });
  writeFileSync(join(empty.agentDir, "waicc-agents.json"), "{}");
  await empty.post();
  assert.match(empty.notices.at(-1)!, /^Nothing was posted\. When you have the token, run \/waicc-mr-comments again/);
});

/** The tracker page's script on these projects; returns its markup. */
function renderTracker(projects: unknown[], tab = "overview"): string {
  const app = { innerHTML: "", textContent: "" }, window: Record<string, any> = {};
  const script = /<script>([\s\S]*)<\/script>/.exec(readFileSync(new URL("../templates/tracker.html", import.meta.url), "utf8"))![1];
  runInNewContext(script, {
    window, location: { hash: "" }, history: { replaceState() {} }, localStorage: { getItem: (k: string) => (k === "waicc-tab" ? tab : null), setItem() {} }, setInterval() {},
    document: { getElementById: (name: string) => (name === "app" ? app : { textContent: "", addEventListener() {} }), addEventListener() {}, querySelectorAll: () => [], createElement: () => ({ remove() {} }), body: { appendChild() {} } },
  });
  window.waiccTracker({ generatedAt: new Date().toISOString(), projects: JSON.parse(JSON.stringify(projects)) });
  return app.innerHTML;
}

test("the tracker shows which merge request a session reviews, links it, and what is ready to post or was posted", async (t) => {
  const h = await run(t, { select: (options) => options[0] });
  const before = projectStatus(h.root);
  const change = before.sessions[0].change!;
  assert.deepEqual(change.mergeRequest, { number: 7, provider: "gitlab", target: "develop", webUrl: "https://gitlab.example.com/team/app/-/merge_requests/7" });
  assert.equal(change.awaitingPost, true);
  assert.equal(change.toPost, 2);
  assert.deepEqual(before.needsYou.filter((n) => n.command === "/waicc-mr-comments").map((n) => n.text), ["Review of merge request !7 is ready to post to GitLab: 2 findings"]);
  const page = renderTracker([before]);
  assert.match(page, /<a class="chip mr" href="https:\/\/gitlab\.example\.com\/team\/app\/-\/merge_requests\/7" target="_blank" rel="noopener noreferrer" title="Open it">MR !7 → develop ↗<\/a>/);
  assert.match(page, /nothing posted to GitLab yet · <span style="color:var\(--warn\)">ready to post \(2 findings\): <code>\/waicc-mr-comments<\/code>/);
  assert.match(page, /<span class="chip mr">MR !7 → develop<\/span>/, "on the project's card too");
  assert.match(renderTracker([before], "timeline"), new RegExp(`code review at ${h.head.slice(0, 10)}`), "the timeline says which commit was reviewed");

  await h.post();
  const after = projectStatus(h.root);
  assert.deepEqual([after.sessions[0].change!.awaitingPost, after.sessions[0].change!.toPost], [false, 0]);
  assert.equal(after.sessions[0].change!.posted!.lineComments, 1);
  assert.equal(after.needsYou.filter((n) => n.command === "/waicc-mr-comments").length, 0, "posted: no longer waiting on you");
  assert.match(renderTracker([after]), /posted to GitLab: 1 line comment and a summary, last \d+[smhd]/);

  assert.equal(mergeRequestUrl({ remote: "origin", number: 45, provider: "github", target: "main", url: "git@github.com:whatley95/pi-waicc.git", head: "x" }), "https://github.com/whatley95/pi-waicc/pull/45");
  assert.equal(mergeRequestUrl({ remote: "origin", number: 3, provider: "gitlab", target: "main", url: "git@gitlab.example.com:group/app.git", head: "x" }), "https://gitlab.example.com/group/app/-/merge_requests/3");
});

test("a remote's address that redirects is followed without a token, and the client never follows a redirect with it", async (t) => {
  const tokens: (string | string[] | undefined)[] = [];
  const target = createServer((req, res) => {
    tokens.push(req.headers["private-token"]);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "401 Unauthorized" }));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const to = (target.address() as { port: number }).port;
  // The remote's address: every path moves to the other server, as nginx does for http → https.
  const front = createServer((req, res) => {
    tokens.push(req.headers["private-token"]);
    res.writeHead(301, { Location: `http://localhost:${to}${req.url}` });
    res.end("<html>301 Moved Permanently</html>");
  });
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  t.after(() => { front.close(); target.close(); });
  const from = (front.address() as { port: number }).port;

  const remote = gitlabProject(`http://127.0.0.1:${from}/group/app.git`);
  const found = await canonicalProject(remote);
  assert.deepEqual(found, { origin: `http://localhost:${to}`, host: `localhost:${to}`, path: "group/app", secure: false });
  assert.deepEqual(tokens, [undefined, undefined], "the address is found without sending a token anywhere");
  assert.deepEqual(await canonicalProject(gitlabProject("http://127.0.0.1:9/x/y.git")), gitlabProject("http://127.0.0.1:9/x/y.git"), "unreachable: the remote's own address stands");

  // The client itself never follows a redirect with your token, and says where it points.
  const call = gitlabClient(remote, { token: "glpat-x", allowHttp: true });
  await assert.rejects(call("GET", "/merge_requests?state=opened"), /GitLab at 127\.0\.0\.1:\d+ redirected GET \/merge_requests to http:\/\/localhost:\d+\/api\/v4\/projects\/group%2Fapp\/merge_requests; WAICC does not send your token on to another address/);
  assert.equal(tokens.filter(Boolean).length, 1, "only the one request to the listed address carried it");
});

test("the API client sends the token only as a header, reads GitLab's errors, and refuses plain http unless allowed", async (t) => {
  const seen: { url?: string; token?: string | string[]; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, token: req.headers["private-token"], body });
      if (req.url!.includes("/merge_requests/8")) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ message: "404 Not found" })); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 5, ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const project = gitlabProject(`http://127.0.0.1:${port}/team/app.git`);
  assert.throws(() => gitlabClient(project, { token: "glpat-x", allowHttp: false }), /plain http, which would send your token unencrypted/);
  assert.throws(() => gitlabClient(project, { token: null, allowHttp: true }), /No GitLab token for 127\.0\.0\.1/);
  const call = gitlabClient(project, { token: "glpat-x", allowHttp: true });
  assert.deepEqual(await call("POST", "/merge_requests/7/notes", { body: "hi" }), { id: 5, ok: true });
  assert.equal(seen[0].url, "/api/v4/projects/team%2Fapp/merge_requests/7/notes");
  assert.equal(seen[0].token, "glpat-x");
  assert.deepEqual(JSON.parse(seen[0].body), { body: "hi" });
  await assert.rejects(call("GET", "/merge_requests/8"), /GitLab GET \/merge_requests\/8 failed \(HTTP 404\): 404 Not found/);
});
