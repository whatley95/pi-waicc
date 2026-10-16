import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  digest,
  json,
  loadSession,
  safePath,
  sessionRelative,
  withLock,
} from "../src/files.ts";
import { curate, propose, recall } from "../src/memory.ts";
import { roundDirectory } from "../src/render.ts";
import { projectRoot, snapshot } from "../src/source.ts";
import { configureSvnIgnore } from "../src/ignore.ts";
import {
  amend,
  assess,
  cancel,
  createSession,
  exportHandoff,
  ingest,
  issue,
  prepare,
  readContract,
  setRoundLimit,
  status,
} from "../src/workflow.ts";
import { readyContract, validateContract } from "../src/validation.ts";
import type { Contract, Reply, Session } from "../src/types.ts";
import { pathToFileURL } from "node:url";

function fixture(t: TestContext, git = false): string {
  const root = mkdtempSync(join(tmpdir(), "waicc-test-"));
  t.after(() => {
    assert.ok(basename(root).startsWith("waicc-test-"));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "app.txt"), "original source\n");
  if (git)
    execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  return root;
}
const requirements = "Add customer search. Protect customer data.";
function example(): Contract {
  return {
    title: "Customer search",
    requirements: [
      {
        id: "REQ-001",
        text: "Search customers",
        sourceQuote: "Add customer search.",
      },
      {
        id: "REQ-002",
        text: "Enforce customer authorization",
        sourceQuote: "Protect customer data.",
      },
    ],
    exclusions: ["Deployment"],
    assumptions: [],
    questions: [],
    risks: ["Cross-account access"],
    skills: ["wai-api-contracts", "wai-security"],
    tasks: [
      {
        id: "API",
        title: "Define search API and authorization",
        requirementIds: ["REQ-001", "REQ-002"],
        dependsOn: [],
        allowedPaths: ["app.txt"],
        acceptance: [
          {
            id: "AC-001",
            text: "Search returns permitted customers only",
            requirementIds: ["REQ-001", "REQ-002"],
            verification:
              "Positive pagination and negative cross-account tests",
          },
        ],
      },
      {
        id: "CLIENT",
        title: "Connect the search client",
        requirementIds: ["REQ-001"],
        dependsOn: ["API"],
        allowedPaths: ["client"],
        acceptance: [
          {
            id: "AC-002",
            text: "Client renders the paginated result and failure states",
            requirementIds: ["REQ-001"],
            verification: "Component and API integration checks",
          },
        ],
      },
    ],
  };
}
function planned(root: string): Session {
  const s = createSession(root, requirements);
  return prepare(
    root,
    s.id,
    example(),
    "planning",
    "Investigate the design, dependencies and authorization.",
    0,
  );
}
function respond(
  root: string,
  session: Session,
  modify?: (reply: Reply) => void,
): Reply {
  const round = session.rounds.at(-1)!;
  const path = join(root, sessionRelative(session.id), roundDirectory(round));
  const reply = JSON.parse(
    readFileSync(join(path, "reply.example.json"), "utf8"),
  ) as Reply;
  reply.outcome = "ready";
  reply.summary = "Investigated the requirements and actual source.";
  reply.questions = [];
  reply.coverage.forEach((row) => {
    row.status = "addressed";
    row.evidence =
      "app.txt and the matching task acceptance criteria were examined.";
  });
  reply.checks = [
    {
      description: "Read source",
      outcome: "passed",
      evidence:
        "Examined app.txt; this is source inspection, not a test execution.",
    },
  ];
  modify?.(reply);
  writeFileSync(join(path, "reply.json"), json(reply));
  return reply;
}
function assessment(s: Session) {
  return {
    requestId: s.rounds.at(-1)!.id,
    decision: "ready" as const,
    rationale:
      "Checked requirements, dependency coverage and evidence against current source.",
    dispositions: [],
  };
}

test("full planning → implementation handoff → implementation reply → independent review cycle", (t) => {
  const root = fixture(t);
  let s = planned(root);
  assert.equal(s.status, "WAITING_FOR_REPLY");
  respond(root, s);
  s = ingest(root, s.id);
  assert.equal(s.status, "AWAITING_ASSESSMENT");
  s = assess(root, s.id, assessment(s));
  assert.equal(s.status, "READY_FOR_HANDOFF");
  assert.equal(s.rounds.at(-1)!.mode, "implementation");
  const history = JSON.parse(
    readFileSync(
      join(
        root,
        sessionRelative(s.id),
        roundDirectory(s.rounds.at(-1)!),
        "conversation.json",
      ),
      "utf8",
    ),
  );
  assert.equal(history[0].requestId, s.rounds[0].id);
  assert.equal(history[0].decision, "ready");
  // External implementation may change source; the extension itself did not.
  assert.equal(
    readFileSync(join(root, "app.txt"), "utf8"),
    "original source\n",
  );
  writeFileSync(join(root, "app.txt"), "implemented search\n");
  respond(root, s);
  s = ingest(root, s.id);
  s = assess(root, s.id, assessment(s));
  assert.equal(s.status, "NEEDS_REVIEW");
  s = issue(
    root,
    s.id,
    "review",
    "Review authorization, search and actual implementation evidence.",
  );
  respond(root, s);
  s = ingest(root, s.id);
  s = assess(root, s.id, assessment(s));
  assert.equal(s.status, "READY_FOR_HANDOFF");
  assert.equal(s.verified, false);
});
test("valid dependency graph is retained; cycles and unknown references are rejected", () => {
  const c = example();
  assert.deepEqual(validateContract(c, requirements), c);
  c.tasks[0].dependsOn = ["CLIENT"];
  assert.throws(() => validateContract(c, requirements), /cycle/);
  c.tasks[0].dependsOn = ["UNKNOWN"];
  assert.throws(() => validateContract(c, requirements), /Unknown dependency/);
});
test("no ready contract can omit acceptance coverage or contain unresolved questions", () => {
  const c = example();
  c.tasks[0].acceptance[0].requirementIds = ["REQ-001"];
  assert.throws(() => readyContract(c), /no acceptance/);
  c.questions.push("What authorization rule applies?");
  assert.throws(() => readyContract(c), /unresolved questions/);
});
test("original quotes must come from the user; paths cannot escape scope", () => {
  const c = example();
  c.requirements[0].sourceQuote = "invented requirement";
  assert.throws(() => validateContract(c, requirements), /exact quote/);
  c.requirements[0].sourceQuote = "Add customer search.";
  for (const path of [
    "../outside",
    "C:\\outside",
    "src/../../secret",
    "src:stream",
    ".git/config",
    ".pi/pi-waicc/contract.json",
    "src/NUL",
  ]) {
    c.tasks[0].allowedPaths = [path];
    assert.throws(() => validateContract(c, requirements), /path/i);
  }
});
test("mismatched request cannot consume a pending handoff", (t) => {
  const root = fixture(t);
  const s = planned(root);
  respond(root, s, (r) => {
    r.requestId = "different-request";
  });
  assert.throws(() => ingest(root, s.id), /identity/);
  assert.equal(loadSession(root, s.id).rounds[0].status, "WAITING");
  respond(root, s);
  assert.equal(ingest(root, s.id).status, "AWAITING_ASSESSMENT");
});
test("incomplete coverage and unsupported command fields fail closed", (t) => {
  const root = fixture(t);
  const s = planned(root);
  respond(root, s, (r) => {
    r.coverage.pop();
  });
  assert.throws(() => ingest(root, s.id), /every requirement/);
  const r = respond(root, s);
  writeFileSync(
    join(
      root,
      sessionRelative(s.id),
      roundDirectory(s.rounds[0]),
      "reply.json",
    ),
    json({ ...r, command: "do something" }),
  );
  assert.throws(() => ingest(root, s.id), /unsupported fields/);
});
test("reply intake is idempotent and freezes the inspected response", (t) => {
  const root = fixture(t);
  const s = planned(root);
  respond(root, s);
  const a = ingest(root, s.id);
  const b = ingest(root, s.id);
  assert.equal(a.sequence, b.sequence);
  respond(root, s, (r) => {
    r.summary = "Changed later";
  });
  assert.equal(
    ingest(root, s.id).rounds[0].reply!.summary,
    a.rounds[0].reply!.summary,
  );
});
test("source change during planning marks its reply stale", (t) => {
  const root = fixture(t);
  const s = planned(root);
  respond(root, s);
  writeFileSync(join(root, "app.txt"), "changed while planning");
  const next = ingest(root, s.id);
  assert.equal(next.status, "STALE");
  assert.throws(() => assess(root, s.id, assessment(next)), /current reply/);
  assert.equal(
    issue(root, s.id, "planning", "Recheck the changed source").status,
    "WAITING_FOR_REPLY",
  );
});
test("source change between intake and assessment cannot slip through", (t) => {
  const root = fixture(t);
  const s = planned(root);
  respond(root, s);
  const received = ingest(root, s.id);
  writeFileSync(join(root, "app.txt"), "changed after intake");
  assert.throws(
    () => assess(root, s.id, assessment(received)),
    /Source changed/,
  );
  assert.equal(ingest(root, s.id).status, "STALE");
});
test("high findings require explicit dispositions; unverified coverage cannot pass", (t) => {
  const root = fixture(t);
  const s = planned(root);
  respond(root, s, (r) => {
    r.findings.push({
      id: "F-001",
      severity: "high",
      description: "Authorization is unspecified",
      evidence: "REQ-002 lacks a concrete identity boundary",
    });
  });
  const received = ingest(root, s.id);
  assert.throws(() => assess(root, s.id, assessment(received)), /dispositions/);
  const accepted = assess(root, s.id, {
    ...assessment(received),
    dispositions: [
      {
        findingId: "F-001",
        disposition: "disputed",
        evidence:
          "Inspected the acceptance criterion and existing authorization boundary; recorded the intended policy.",
      },
    ],
  });
  assert.equal(accepted.verified, false);
  const root2 = fixture(t);
  const s2 = planned(root2);
  respond(root2, s2, (r) => {
    r.coverage[0].status = "unverified";
  });
  const received2 = ingest(root2, s2.id);
  assert.throws(
    () => assess(root2, s2.id, assessment(received2)),
    /coverage gaps/,
  );
});
test("journal survives an interrupted or corrupt session cache", (t) => {
  const root = fixture(t);
  const s = planned(root);
  writeFileSync(
    join(root, sessionRelative(s.id), "session.json"),
    "partial cache {",
  );
  assert.equal(loadSession(root, s.id).sequence, s.sequence);
});
test("uncommitted artifact from a crash can be replaced without rewriting history", (t) => {
  const root = fixture(t);
  const s = createSession(root, requirements);
  const path = join(root, sessionRelative(s.id), "contracts/v001");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "contract.json"), "orphaned partial transaction");
  const committed = prepare(root, s.id, example(), "planning", "Inspect", 0);
  assert.equal(readContract(root, s.id).version, 1);
  assert.throws(
    () => prepare(root, s.id, example(), "planning", "Inspect", 0),
    /version changed/,
  );
  assert.equal(loadSession(root, s.id).sequence, committed.sequence);
});
test("active writer lock cannot be stolen or removed by a failed second writer", (t) => {
  const root = fixture(t);
  withLock(root, () => {
    assert.throws(() => createSession(root, requirements), /locked/);
    assert.ok(existsSync(join(root, ".pi/pi-waicc/write.lock")));
  });
  assert.ok(!existsSync(join(root, ".pi/pi-waicc/write.lock")));
});
test("a junction cannot redirect runtime writes outside the project", (t) => {
  const root = fixture(t);
  const other = fixture(t);
  symlinkSync(
    other,
    join(root, ".pi"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => createSession(root, requirements), /Symlink|junction/);
  assert.ok(!existsSync(join(other, "pi-waicc")));
  assert.throws(() => safePath(root, "../outside"), /component/);
});
test("Git ignores generated state and its writes do not change the source fingerprint", (t) => {
  const root = fixture(t, true);
  const before = snapshot(root);
  const s = planned(root);
  const after = snapshot(root);
  assert.equal(before.fingerprint, after.fingerprint);
  const ignored = execFileSync(
    "git",
    ["check-ignore", join(".pi", "pi-waicc", "sessions", s.id, "session.json")],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  assert.ok(ignored.length > 0);
  const changed = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.ok(!changed.includes(".pi"));
  mkdirSync(join(root, "subfolder"));
  assert.equal(projectRoot(join(root, "subfolder")), root);
});
test("Git index changes are detected even when working-tree content stays identical", (t) => {
  const root = fixture(t, true);
  const before = snapshot(root);
  execFileSync("git", ["add", "app.txt"], { cwd: root, windowsHide: true });
  const after = snapshot(root);
  assert.deepEqual(before.files, after.files);
  assert.notEqual(before.fingerprint, after.fingerprint);
});
test("tracked source under a build-named directory remains in the Git fingerprint", (t) => {
  const root = fixture(t, true);
  mkdirSync(join(root, "build"));
  writeFileSync(join(root, "build/compiler.txt"), "tracked build tooling");
  execFileSync("git", ["add", "build/compiler.txt"], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  });
  const before = snapshot(root);
  assert.ok(before.files["build/compiler.txt"]);
  writeFileSync(join(root, "build/compiler.txt"), "modified build tooling");
  assert.notEqual(snapshot(root).fingerprint, before.fingerprint);
});
test("SVN detects content/property changes and explicit ignore preserves prior rules", (t) => {
  const base = fixture(t);
  const repository = join(base, "repository");
  const root = join(base, "working-copy");
  const run = (binary: string, args: string[], cwd = base) =>
    execFileSync(binary, args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  run("svnadmin", ["create", repository]);
  run("svn", ["checkout", pathToFileURL(repository).href, root]);
  writeFileSync(join(root, "app.txt"), "original source\n");
  run("svn", ["add", "app.txt"], root);
  run("svn", ["commit", "-m", "fixture"], root);
  const before = snapshot(root);
  assert.equal(before.vcs, "svn");
  planned(root);
  assert.equal(snapshot(root).fingerprint, before.fingerprint);
  run("svn", ["propset", "svn:ignore", "existing-rule", "."], root);
  const configured = configureSvnIgnore(root);
  assert.equal(configured.added, ".pi");
  const ignore = run("svn", ["propget", "svn:ignore", "."], root);
  assert.ok(ignore.includes("existing-rule"));
  assert.ok(ignore.includes(".pi"));
  const pinned = snapshot(root);
  run("svn", ["propset", "custom:property", "new-value", "app.txt"], root);
  assert.notEqual(snapshot(root).fingerprint, pinned.fingerprint);
  writeFileSync(join(root, "app.txt"), "new source");
  assert.notDeepEqual(snapshot(root).files, pinned.files);
});
test("memory candidates need human confirmation and become stale with their source", (t) => {
  const root = fixture(t);
  const m = propose(
    root,
    "The source entry point is app.txt",
    "app.txt",
    "fact",
  );
  assert.equal(recall(root).length, 0);
  assert.equal(recall(root, "", true)[0].state, "candidate");
  curate(root, m.id, "confirm");
  assert.equal(recall(root)[0].id, m.id);
  assert.equal(propose(root, m.text, m.source, m.kind).id, m.id);
  writeFileSync(join(root, "app.txt"), "different source");
  assert.equal(recall(root).length, 0);
  assert.equal(recall(root, "", true)[0].state, "stale");
  assert.throws(() => curate(root, m.id, "confirm"), /source changed/);
});
test("amendments preserve original requirements and invalidate pending requests", (t) => {
  const root = fixture(t);
  const s = planned(root);
  const next = amend(root, s.id, "Also add pagination.");
  assert.equal(next.requirements[0], requirements);
  assert.equal(next.rounds[0].status, "STALE");
  assert.equal(
    readFileSync(join(root, sessionRelative(s.id), "requirements.md"), "utf8"),
    `${requirements}\n`,
  );
  const c = example();
  c.requirements.push({
    id: "REQ-003",
    text: "Paginate",
    sourceQuote: "Also add pagination.",
  });
  c.tasks[0].requirementIds.push("REQ-003");
  c.tasks[0].acceptance[0].requirementIds.push("REQ-003");
  assert.equal(
    prepare(root, s.id, c, "planning", "Inspect amended scope", 1)
      .contractVersion,
    2,
  );
});
test("portable export includes selected skill references, pinned identity and complete requirements", (t) => {
  const root = fixture(t);
  const s = planned(root);
  const path = exportHandoff(root, s.id);
  const manifest = JSON.parse(
    readFileSync(join(path, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.requestId, s.rounds[0].id);
  assert.equal(manifest.includesSourceCode, false);
  assert.ok(
    existsSync(join(path, "skills/wai-api-contracts/references/checks.md")),
  );
  assert.equal(
    JSON.parse(readFileSync(join(path, "reply.example.json"), "utf8"))
      .sessionId,
    s.id,
  );
  assert.equal(
    readFileSync(join(path, "requirements.md"), "utf8"),
    requirements,
  );
  assert.equal(snapshot(root).fingerprint, s.rounds[0].source.fingerprint);
});
test("round limit stops repeated handoffs and can be changed explicitly", (t) => {
  const root = fixture(t);
  let s = planned(root);
  setRoundLimit(root, s.id, 2);
  cancel(root, s.id, "Need another investigation");
  s = issue(root, s.id, "planning", "Second round");
  cancel(root, s.id, "Still unresolved");
  assert.throws(
    () => issue(root, s.id, "planning", "Third round"),
    /round limit/,
  );
  setRoundLimit(root, s.id, 3);
  assert.equal(issue(root, s.id, "planning", "Third round").rounds.length, 3);
});
test("contract and source artifacts detect accidental modification", (t) => {
  const root = fixture(t);
  const s = planned(root);
  const path = join(
    root,
    sessionRelative(s.id),
    "contracts/v001/contract.json",
  );
  writeFileSync(path, "{}");
  assert.throws(() => readContract(root, s.id), /modified/);
});
test("external implementation outside its allowed source paths cannot become ready", (t) => {
  const root = fixture(t);
  let s = planned(root);
  respond(root, s);
  s = ingest(root, s.id);
  s = assess(root, s.id, assessment(s));
  writeFileSync(join(root, "unexpected.txt"), "outside the contract");
  respond(root, s);
  s = ingest(root, s.id);
  assert.throws(
    () => assess(root, s.id, assessment(s)),
    /outside its contract/,
  );
});
test("proposed contracts remain advice until explicitly adopted in assessment", (t) => {
  const root = fixture(t);
  const s = planned(root);
  const proposed = example();
  proposed.risks.push("Newly discovered pagination race");
  respond(root, s, (reply) => {
    reply.proposedContract = proposed;
  });
  const received = ingest(root, s.id);
  assert.equal(readContract(root, s.id).version, 1);
  const adopted = assess(root, s.id, {
    ...assessment(received),
    contract: proposed,
  });
  assert.equal(adopted.contractVersion, 2);
  assert.deepEqual(readContract(root, s.id).contract.risks, proposed.risks);
});
test("CLI can create and recover sessions without a Pi process", (t) => {
  const root = fixture(t);
  const cli = resolve("src/cli.ts");
  const invoke = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, "--root", root, ...args], {
        encoding: "utf8",
        windowsHide: true,
      }),
    );
  const s = invoke("start", requirements);
  assert.equal(s.status, "DRAFT");
  const recovered = invoke("status", s.id);
  assert.equal(recovered.sessionId, s.id);
  assert.equal(recovered.verified, false);
});
