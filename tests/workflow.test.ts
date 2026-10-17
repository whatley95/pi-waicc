import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  digest,
  artifact,
  json,
  listSessions,
  loadSession,
  safePath,
  sessionRelative,
  withLock,
} from "../src/files.ts";
import { curate, propose, recall } from "../src/memory.ts";
import {
  roundDirectory,
  manualHandoffMessage,
  type manualHandoff,
} from "../src/render.ts";
import { projectRoot, snapshot } from "../src/source.ts";
import { configureSvnIgnore } from "../src/ignore.ts";
import {
  amend,
  assess,
  cancel,
  closeSession,
  createSession,
  exportHandoff,
  forceCloseSession,
  ingest,
  issue,
  prepare,
  readContract,
  reopenSession,
  setRoundLimit,
  status,
} from "../src/workflow.ts";
import {
  advisorInput,
  readyContract,
  readyPlan,
  validateContract,
  validateReply,
} from "../src/validation.ts";
import type { Contract, Reply, Session } from "../src/types.ts";
import { pathToFileURL } from "node:url";
import { decisionGates } from "../src/decisions.ts";

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

function gatedPlan(): Contract {
  return {
    ...example(),
    decisions: [
      {
        id: "DEC-001",
        question: "Which client presentation does the owner want?",
        owner: "human",
        status: "deferred",
        affectedTaskIds: ["CLIENT"],
        evidence: [
          "Source establishes the API boundary; the requested presentation choice is not specified",
        ],
        recommendation:
          "Keep existing presentation until the owner chooses; gate CLIENT",
      },
    ],
  };
}

test("a source-backed plan is accepted with future task decisions and no implementation handoff", (t) => {
  const root = fixture(t);
  const original = createSession(root, requirements);
  const brief = { ...example(), tasks: [] };
  const s = prepare(
    root,
    original.id,
    brief,
    "planning",
    "Investigate source and form the plan",
    0,
  );
  respond(root, s, (reply) => {
    reply.outcome = "planned";
    reply.proposedContract = gatedPlan();
    reply.checks = [
      {
        description: "Build/tests",
        outcome: "not_run",
        evidence: "Planning uses source inspection; no test execution claimed",
      },
    ];
  });
  const received = ingest(root, s.id);
  assert.throws(
    () => assess(root, s.id, { ...assessment(received), decision: "planned" }),
    /acceptance criteria/,
  );
  const accepted = assess(root, s.id, {
    ...assessment(received),
    decision: "planned",
    contract: gatedPlan(),
  });
  assert.equal(accepted.status, "PLAN_READY");
  assert.equal(accepted.contractVersion, 2);
  assert.equal(accepted.rounds.length, 1);
  assert.equal(accepted.rounds[0].status, "ASSESSED");
  assert.equal(accepted.deliveryVerified, false);
  assert.equal(accepted.rounds[0].reply!.checks[0].outcome, "not_run");
  const view = status(root, s.id) as {
    pending: unknown;
    manualHandoff: unknown;
    decisionGates: ReturnType<typeof decisionGates>;
  };
  assert.equal(view.pending, null);
  assert.equal(view.manualHandoff, null);
  assert.deepEqual(view.decisionGates.decisionUnblockedTaskIds, ["API"]);
  assert.deepEqual(view.decisionGates.decisionBlockedTaskIds, ["CLIENT"]);
  assert.ok(
    artifact(root, accepted, "contracts/v002/CONTRACT.md").includes("DEC-001"),
  );
  assert.throws(
    () => readyContract(readContract(root, s.id).contract),
    /Execution is gated/,
  );
});

test("planned still rejects unverified coverage, failed checks, human blockers and unresolved high findings", (t) => {
  for (const failure of ["coverage", "checks", "questions", "findings"]) {
    const root = fixture(t),
      s = planned(root);
    respond(root, s, (reply) => {
      reply.outcome = "planned";
      if (failure === "coverage") reply.coverage[0].status = "unverified";
      if (failure === "checks") reply.checks[0].outcome = "failed";
      if (failure === "questions")
        reply.questions = [
          "Missing information prevents a coherent specification",
        ];
      if (failure === "findings")
        reply.findings = [
          {
            id: "F-001",
            severity: "high",
            description: "Unresolved authorization boundary",
            evidence: "Source is contradictory",
          },
        ];
    });
    const received = ingest(root, s.id);
    assert.throws(() =>
      assess(root, s.id, { ...assessment(received), decision: "planned" }),
    );
    assert.equal(loadSession(root, s.id).sequence, received.sequence);
  }
});

test("decisions require investigation evidence, task scope and explicit recorded answers", () => {
  assert.doesNotThrow(() =>
    readyPlan(validateContract(gatedPlan(), requirements)),
  );
  for (const change of [
    { affectedTaskIds: ["UNKNOWN"] },
    { evidence: [] },
    { status: "resolved" },
    { owner: "someone" },
    { status: "maybe" },
    { answer: "Pretend approval" },
  ]) {
    const c = gatedPlan();
    Object.assign(c.decisions![0], change);
    assert.throws(() => validateContract(c, requirements));
  }
  const agentOwned = gatedPlan();
  agentOwned.decisions![0].owner = "agent";
  assert.throws(
    () => readyPlan(validateContract(agentOwned, requirements)),
    /agent-owned/,
  );
  const resolved = gatedPlan();
  resolved.decisions![0].status = "resolved";
  resolved.decisions![0].answer =
    "Owner confirmed the existing presentation; decision source recorded";
  assert.doesNotThrow(() =>
    readyContract(validateContract(resolved, requirements)),
  );
});

test("decision gates propagate to dependent tasks without blocking independent tasks", () => {
  const c = gatedPlan();
  c.tasks.push({
    ...structuredClone(c.tasks[1]),
    id: "FOLLOW",
    dependsOn: ["CLIENT"],
    acceptance: [{ ...c.tasks[1].acceptance[0], id: "AC-003" }],
  });
  validateContract(c, requirements);
  const gates = decisionGates(c);
  assert.deepEqual(gates.decisionBlockedTaskIds, ["CLIENT", "FOLLOW"]);
  assert.deepEqual(gates.decisionUnblockedTaskIds, ["API"]);
});

test("review and human closure can accept documented future gates without authorizing execution", (t) => {
  const root = fixture(t),
    initial = createSession(root, requirements);
  const s = prepare(
    root,
    initial.id,
    gatedPlan(),
    "review",
    "Independently verify the gated specification",
    0,
  );
  respond(root, s);
  const received = ingest(root, s.id);
  const passed = assess(root, s.id, assessment(received));
  assert.equal(passed.status, "READY_TO_CLOSE");
  assert.equal(passed.contractReview, "PASS");
  assert.throws(
    () => readyContract(readContract(root, s.id).contract),
    /Execution is gated/,
  );
  const closed = closeSession(
    root,
    s.id,
    "Accept the specification with explicit future decision gates",
  );
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.deliveryVerified, false);
  assert.equal(
    readContract(root, s.id).contract.decisions![0].status,
    "deferred",
  );
});

test("planned rejects stale source and decision removal; other modes cannot use planned", (t) => {
  const root = fixture(t),
    initial = createSession(root, requirements);
  const s = prepare(
    root,
    initial.id,
    gatedPlan(),
    "planning",
    "Investigate",
    0,
  );
  respond(root, s, (reply) => {
    reply.outcome = "planned";
  });
  const received = ingest(root, s.id);
  assert.throws(
    () =>
      assess(root, s.id, {
        ...assessment(received),
        decision: "planned",
        contract: example(),
      }),
    /Preserve decision/,
  );
  writeFileSync(join(root, "app.txt"), "Source changed");
  assert.throws(
    () => assess(root, s.id, { ...assessment(received), decision: "planned" }),
    /Source changed/,
  );
  for (const mode of ["review", "advisor", "implementation"]) {
    assert.throws(
      () =>
        validateReply({
          ...received.rounds[0].reply!,
          mode,
          outcome: "planned",
        }),
      /only valid for planning/,
    );
  }
});
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
const advisorQuestion = "Should search use cursor or offset pagination?";
function reviewing(root: string): Session {
  const s = planned(root);
  cancel(root, s.id, "Review the contract before implementation");
  return issue(
    root,
    s.id,
    "review",
    "Review full-contract readiness and evidence",
  );
}
function passedReview(root: string): Session {
  let s = reviewing(root);
  respond(root, s);
  s = ingest(root, s.id);
  return assess(root, s.id, assessment(s));
}

test("full review PASS signals READY_TO_CLOSE, and explicit closure preserves the pinned decision without verifying delivery", (t) => {
  const root = fixture(t);
  let s = reviewing(root);
  assert.equal(s.contractReview, "PENDING");
  respond(root, s);
  assert.throws(
    () => closeSession(root, s.id, "Not yet assessed"),
    /READY_TO_CLOSE/,
  );
  s = ingest(root, s.id);
  assert.equal(s.contractReview, "PENDING");
  s = assess(root, s.id, assessment(s));
  assert.equal(s.status, "READY_TO_CLOSE");
  assert.equal(s.contractReview, "PASS");
  assert.equal(s.closure, undefined);
  assert.equal(s.reviewApproval!.contractVersion, 1);
  assert.equal(s.reviewApproval!.requestId, s.rounds.at(-1)!.id);
  assert.equal(s.reviewApproval!.sourceFingerprint, snapshot(root).fingerprint);
  const before = s;
  s = closeSession(root, s.id, "Contract accepted for implementation");
  assert.equal(s.status, "CLOSED");
  assert.equal(s.contractReview, "PASS");
  assert.equal(s.verified, false);
  assert.equal(s.deliveryVerified, false);
  assert.equal(s.contractVersion, before.contractVersion);
  assert.equal(s.rounds.length, before.rounds.length);
  assert.equal(s.createdAt, before.createdAt);
  assert.deepEqual(s.closure!.approval, before.reviewApproval);
  assert.equal(s.closure!.reason, "Contract accepted for implementation");
  const record = JSON.parse(
    readFileSync(
      join(
        root,
        sessionRelative(s.id),
        `lifecycle/${s.closure!.id}/closure.json`,
      ),
      "utf8",
    ),
  );
  assert.equal(record.status, "CLOSED");
  assert.equal(record.contractReview, "PASS");
  assert.equal(record.deliveryVerified, false);
  assert.deepEqual(record.closure, s.closure);
  assert.equal(listSessions(root)[0].status, "CLOSED");
  assert.equal(listSessions(root)[0].contractReview, "PASS");
  assert.equal(listSessions(root)[0].deliveryVerified, false);
  writeFileSync(
    join(root, sessionRelative(s.id), "session.json"),
    "broken cache",
  );
  assert.deepEqual(loadSession(root, s.id).closure, s.closure);
  assert.equal(ingest(root, s.id).sequence, s.sequence);
  assert.throws(() => closeSession(root, s.id, "Already closed"), /closed/);
});

test("planning readiness and advisor advice cannot close a contract", (t) => {
  const root = fixture(t);
  let s = planned(root);
  assert.throws(
    () => closeSession(root, s.id, "Pending planning"),
    /READY_TO_CLOSE/,
  );
  respond(root, s);
  s = ingest(root, s.id);
  s = assess(root, s.id, assessment(s));
  assert.equal(s.status, "READY_FOR_HANDOFF");
  assert.equal(s.contractReview, "NOT_REVIEWED");
  assert.throws(
    () => closeSession(root, s.id, "Plan is not a review"),
    /READY_TO_CLOSE/,
  );
  cancel(root, s.id, "Pause implementation");
  s = issue(root, s.id, "advisor", advisorQuestion);
  adviceReply(root, s);
  s = ingest(root, s.id);
  s = assess(root, s.id, { ...assessment(s), decision: "noted" });
  assert.equal(s.status, "ADVICE_READY");
  assert.equal(s.reviewApproval, undefined);
  assert.throws(
    () => closeSession(root, s.id, "Advice is not review"),
    /READY_TO_CLOSE/,
  );
});

test("status reports stale review approval without a write and closure requires fresh inputs", (t) => {
  const root = fixture(t);
  const s = passedReview(root);
  assert.throws(() => closeSession(root, s.id, " "), /Closure reason/);
  writeFileSync(join(root, "app.txt"), "source changed after PASS");
  const detail = status(root, s.id) as {
    status: string;
    contractReview: string;
    updatedAt: string;
  };
  assert.equal(detail.status, "STALE");
  assert.equal(detail.contractReview, "STALE");
  assert.equal(detail.updatedAt, s.updatedAt);
  assert.equal(
    (status(root) as { sessions: { status: string; contractReview: string }[] })
      .sessions[0].status,
    "STALE",
  );
  assert.equal(
    (status(root) as { sessions: { contractReview: string }[] }).sessions[0]
      .contractReview,
    "STALE",
  );
  assert.throws(
    () => closeSession(root, s.id, "Cannot use obsolete PASS"),
    /no longer matches/,
  );
  assert.equal(loadSession(root, s.id).sequence, s.sequence);
  let fresh = issue(root, s.id, "review", "Review the changed source");
  assert.equal(fresh.contractReview, "PENDING");
  assert.equal(fresh.reviewApproval, undefined);
  respond(root, fresh);
  fresh = ingest(root, s.id);
  fresh = assess(root, s.id, assessment(fresh));
  assert.equal(
    closeSession(root, s.id, "Fresh review accepted").status,
    "CLOSED",
  );
});

test("amendments, new requests and revisions invalidate a previous contract review PASS", (t) => {
  for (const action of ["amend", "advisor", "prepare"] as const) {
    const root = fixture(t);
    let s = passedReview(root);
    s =
      action === "amend"
        ? amend(root, s.id, "Also add pagination.")
        : action === "advisor"
          ? issue(root, s.id, "advisor", advisorQuestion)
          : prepare(
              root,
              s.id,
              example(),
              "review",
              "Review revised contract",
              1,
            );
    assert.notEqual(s.contractReview, "PASS");
    assert.equal(s.reviewApproval, undefined);
    assert.throws(
      () => closeSession(root, s.id, "Old review must not close new work"),
      /READY_TO_CLOSE/,
    );
  }
});

test("a reviewer-proposed revision needs a new reviewed version before closure", (t) => {
  const root = fixture(t);
  let s = reviewing(root);
  const revision = example();
  revision.risks.push("Ordering must remain stable");
  respond(root, s, (r) => {
    r.proposedContract = revision;
  });
  s = ingest(root, s.id);
  assert.throws(
    () => assess(root, s.id, { ...assessment(s), contract: revision }),
    /changed contract requires a fresh review/,
  );
  assert.equal(loadSession(root, s.id).contractVersion, 1);
  s = assess(root, s.id, {
    ...assessment(s),
    decision: "followup",
    contract: revision,
  });
  assert.equal(s.contractVersion, 2);
  assert.equal(s.contractReview, "PENDING");
  assert.equal(s.reviewApproval, undefined);
  respond(root, s);
  s = ingest(root, s.id);
  s = assess(root, s.id, assessment(s));
  assert.equal(s.status, "READY_TO_CLOSE");
  assert.equal(s.reviewApproval!.contractVersion, 2);
  assert.equal(
    closeSession(root, s.id, "Revised contract reviewed").status,
    "CLOSED",
  );
});

test("task-scoped review cannot signal whole-contract closure", (t) => {
  const root = fixture(t);
  let s = planned(root);
  cancel(root, s.id, "Review only API task");
  s = issue(root, s.id, "review", "Inspect API task only", "API");
  respond(root, s);
  s = ingest(root, s.id);
  s = assess(root, s.id, assessment(s));
  assert.equal(s.status, "NEEDS_REVIEW");
  assert.equal(s.contractReview, "NOT_REVIEWED");
  assert.equal(s.reviewApproval, undefined);
  assert.throws(
    () => closeSession(root, s.id, "Only one task was reviewed"),
    /READY_TO_CLOSE/,
  );
});

test("closed contracts block mutations; explicit reopening preserves history and requires a fresh review", (t) => {
  const root = fixture(t);
  let s = passedReview(root);
  s = closeSession(root, s.id, "Contract accepted");
  const closureId = s.closure!.id;
  const closurePath = join(
    root,
    sessionRelative(s.id),
    `lifecycle/${closureId}/closure.json`,
  );
  const closed = readFileSync(closurePath, "utf8");
  for (const mutate of [
    () =>
      prepare(root, s.id, example(), "planning", "Not allowed while closed", 1),
    () => issue(root, s.id, "review", "Not allowed while closed"),
    () => amend(root, s.id, "New requirement"),
    () => cancel(root, s.id, "Not allowed while closed"),
    () => assess(root, s.id, assessment(s)),
    () => setRoundLimit(root, s.id, 20),
    () => exportHandoff(root, s.id),
  ])
    assert.throws(mutate, /Contract is closed/);
  assert.throws(() => reopenSession(root, s.id, ""), /Reopening reason/);
  assert.equal(loadSession(root, s.id).sequence, s.sequence);
  s = reopenSession(root, s.id, "Reconsider pagination");
  assert.equal(s.status, "NEEDS_REVIEW");
  assert.equal(s.contractReview, "NOT_REVIEWED");
  assert.equal(s.reviewApproval, undefined);
  assert.equal(s.closure, undefined);
  assert.equal(s.contractVersion, 1);
  assert.equal(readFileSync(closurePath, "utf8"), closed);
  assert.ok(
    existsSync(
      join(root, sessionRelative(s.id), `lifecycle/${closureId}/reopen.json`),
    ),
  );
  assert.throws(
    () => closeSession(root, s.id, "Cannot reuse previous PASS"),
    /READY_TO_CLOSE/,
  );
  assert.throws(
    () => reopenSession(root, s.id, "Already open"),
    /Only a closed/,
  );
  s = issue(root, s.id, "review", "Fresh review after reopening");
  respond(root, s);
  s = ingest(root, s.id);
  s = assess(root, s.id, assessment(s));
  s = closeSession(root, s.id, "Re-reviewed contract accepted");
  assert.notEqual(s.closure!.id, closureId);
  assert.equal(readFileSync(closurePath, "utf8"), closed);
  assert.equal(s.deliveryVerified, false);
});

test("force-close terminates drafts and pending or assessed sessions without review approval", (t) => {
  const root = fixture(t);
  for (const stage of ["draft", "waiting", "received", "assessed"] as const) {
    let s = stage === "draft" ? createSession(root, requirements) : planned(root);
    if (stage === "received" || stage === "assessed") {
      respond(root, s);
      s = ingest(root, s.id);
    }
    if (stage === "assessed")
      s = assess(root, s.id, { ...assessment(s), decision: "needs_changes" });
    const before = s;
    const oldArtifacts = Object.entries(before.artifacts).map(([path]) => [
      path,
      artifact(root, before, path),
    ]);
    s = forceCloseSession(root, s.id);
    assert.equal(s.status, "CLOSED");
    assert.equal(s.contractReview, "NOT_REVIEWED");
    assert.equal(s.reviewApproval, undefined);
    assert.equal(s.closure!.kind, "forced");
    assert.equal(s.closure!.approval, undefined);
    assert.equal(s.deliveryVerified, false);
    assert.equal(s.verified, false);
    assert.equal(s.contractVersion, before.contractVersion);
    assert.equal(s.createdAt, before.createdAt);
    assert.equal(s.sequence, before.sequence + 1);
    assert.deepEqual(s.requirements, before.requirements);
    assert.equal(s.rounds.length, before.rounds.length);
    assert.deepEqual(
      s.rounds.filter((r) => r.status === "ASSESSED"),
      before.rounds.filter((r) => r.status === "ASSESSED"),
    );
    assert.equal(
      s.rounds.some((r) => ["WAITING", "RECEIVED"].includes(r.status)),
      false,
    );
    assert.deepEqual(
      s.closure!.kind === "forced" && s.closure!.cancelledRequestIds,
      before.rounds
        .filter((r) => ["WAITING", "RECEIVED"].includes(r.status))
        .map((r) => r.id),
    );
    for (const [path, content] of oldArtifacts)
      assert.equal(artifact(root, s, path), content);
    const record = JSON.parse(
      artifact(root, s, `lifecycle/${s.closure!.id}/closure.json`),
    );
    assert.equal(record.closure.kind, "forced");
    assert.equal(record.closure.approval, undefined);
    assert.equal(record.contractReview, "NOT_REVIEWED");
    assert.equal(record.deliveryVerified, false);
    const view = status(root, s.id) as { pending: unknown; nextAction: string };
    assert.equal(view.pending, null);
    assert.match(view.nextAction, /force-closed without review approval/);
    assert.deepEqual(forceCloseSession(root, s.id, "Already stopped"), s);
    assert.deepEqual(loadSession(root, s.id), s);
    assert.equal(ingest(root, s.id).sequence, s.sequence);
    assert.throws(
      () => issue(root, s.id, "planning", "Cannot resume closed work"),
      /closed/,
    );
  }
  assert.equal(readFileSync(join(root, "app.txt"), "utf8"), "original source\n");
});

test("force-close clears prior PASS even on changed source, retains its audit and can be reopened", (t) => {
  const root = fixture(t);
  const before = passedReview(root);
  writeFileSync(join(root, "app.txt"), "new source after review");
  assert.throws(
    () => closeSession(root, before.id, "Old approval"),
    /no longer matches/,
  );
  const closed = forceCloseSession(root, before.id, "Superseded by another contract");
  assert.equal(closed.contractReview, "NOT_REVIEWED");
  assert.equal(closed.reviewApproval, undefined);
  assert.deepEqual(closed.rounds, before.rounds);
  const closurePath = `lifecycle/${closed.closure!.id}/closure.json`;
  const historicalClosure = artifact(root, closed, closurePath);
  const s = reopenSession(root, closed.id, "Resume the investigation");
  assert.equal(s.status, "NEEDS_REVIEW");
  assert.equal(s.contractReview, "NOT_REVIEWED");
  assert.equal(s.closure, undefined);
  assert.equal(s.reviewApproval, undefined);
  assert.equal(artifact(root, s, closurePath), historicalClosure);
  assert.throws(
    () => closeSession(root, s.id, "Cannot reuse earlier PASS"),
    /READY_TO_CLOSE/,
  );
});

test("force-close keeps existing reviewed closure and rejects invalid reasons without mutation", (t) => {
  const root = fixture(t);
  const initial = planned(root);
  const pending = loadSession(root, initial.id);
  assert.throws(
    () => forceCloseSession(root, pending.id, "x".repeat(32_001)),
    /Force-closure reason/,
  );
  assert.deepEqual(loadSession(root, pending.id), pending);
  const reviewed = passedReview(root);
  const closed = closeSession(root, reviewed.id, "Reviewed and accepted");
  assert.deepEqual(forceCloseSession(root, closed.id), closed);
  assert.equal(loadSession(root, closed.id).contractReview, "PASS");
  assert.equal(closed.closure!.kind, "reviewed");
});

test("force-close needs no reply parsing and ignores late replies even after reopening", (t) => {
  const root = fixture(t),
    s = planned(root);
  const replyPath = join(
    root,
    sessionRelative(s.id),
    roundDirectory(s.rounds[0]),
    "reply.json",
  );
  writeFileSync(replyPath, "invalid JSON from an external agent");
  const closed = forceCloseSession(root, s.id);
  assert.equal(readFileSync(replyPath, "utf8"), "invalid JSON from an external agent");
  assert.deepEqual(ingest(root, s.id), closed);
  respond(root, s); // Simulate a late external reply for the cancelled assignment.
  assert.deepEqual(ingest(root, s.id), closed);
  const reopened = reopenSession(root, s.id, "Use a fresh assignment");
  assert.deepEqual(ingest(root, s.id), reopened);
  assert.equal(loadSession(root, s.id).rounds[0].status, "CANCELLED");
  assert.equal((status(root, s.id) as { pending: unknown }).pending, null);
});

test("CLI supports reason-optional cancellation and force-close without a Pi process", (t) => {
  const root = fixture(t);
  const s = planned(root);
  const invoke = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [resolve("src/cli.ts"), "--root", root, ...args],
        { encoding: "utf8", windowsHide: true },
      ),
    );
  assert.equal(invoke("cancel", s.id).rounds[0].rationale, "Cancelled by user.");
  issue(root, s.id, "planning", "Try another plan");
  assert.equal(
    invoke("cancel", s.id, "Custom reason").rounds.at(-1).rationale,
    "Custom reason",
  );
  issue(root, s.id, "planning", "Final handoff");
  const closed = invoke("close", s.id, "--force");
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.closure.kind, "forced");
  assert.equal(closed.closure.reason, "Force-closed by user.");
  assert.equal(closed.contractReview, "NOT_REVIEWED");
  assert.equal(closed.rounds.at(-1).status, "CANCELLED");
  const draft = createSession(root, requirements);
  assert.equal(
    invoke("close", draft.id, "--force", "Restart from scratch").closure.reason,
    "Restart from scratch",
  );
  assert.equal(
    invoke("status", "all").sessions.every((s: Session) => s.status === "CLOSED"),
    true,
  );
});

test("closure rejects tampered review evidence", (t) => {
  const root = fixture(t);
  const s = passedReview(root);
  writeFileSync(
    join(
      root,
      sessionRelative(s.id),
      roundDirectory(s.rounds.at(-1)!),
      "assessment.json",
    ),
    "{}",
  );
  assert.throws(
    () => closeSession(root, s.id, "Evidence must stay immutable"),
    /modified/,
  );
});

test("legacy handoff-ready sessions are not silently promoted to review PASS", (t) => {
  const root = fixture(t);
  const s = passedReview(root);
  const dir = join(root, sessionRelative(s.id), "journal");
  const path = join(dir, readdirSync(dir).sort().at(-1)!);
  const entry = JSON.parse(readFileSync(path, "utf8"));
  entry.session.status = "READY_FOR_HANDOFF";
  delete entry.session.contractReview;
  delete entry.session.reviewApproval;
  delete entry.session.deliveryVerified;
  writeFileSync(path, json(entry));
  const old = loadSession(root, s.id);
  assert.equal(old.contractReview, "NOT_REVIEWED");
  assert.equal(old.deliveryVerified, false);
  assert.throws(
    () => closeSession(root, s.id, "Need a fresh review"),
    /READY_TO_CLOSE/,
  );
});

test("CLI supports explicit close and reopen, without model inference", (t) => {
  const root = fixture(t);
  const s = passedReview(root);
  const invoke = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [resolve("src/cli.ts"), "--root", root, ...args],
        { encoding: "utf8", windowsHide: true },
      ),
    );
  const closed = invoke("close", s.id, "Contract accepted for implementation");
  assert.equal(closed.status, "CLOSED");
  assert.equal(invoke("status", s.id).contractReview, "PASS");
  assert.equal(invoke("status", "all").sessions[0].status, "CLOSED");
  const reopened = invoke("reopen", s.id, "Revisit assumptions");
  assert.equal(reopened.status, "NEEDS_REVIEW");
  assert.equal(reopened.contractReview, "NOT_REVIEWED");
});

function advising(root: string, ids: string[] = []): Session {
  const s = planned(root);
  cancel(root, s.id, "Pause planning for a focused design decision");
  return issue(root, s.id, "advisor", advisorQuestion, undefined, ids);
}
function adviceReply(
  root: string,
  s: Session,
  modify?: (reply: Reply) => void,
): Reply {
  return respond(root, s, (reply) => {
    reply.advice!.options = [
      {
        id: "cursor",
        title: "Cursor pagination",
        benefits: ["Stable page boundary"],
        tradeoffs: ["Opaque cursor handling"],
        evidence: [
          "API acceptance AC-001 requires pagination; ordering is not implemented in app.txt.",
        ],
      },
      {
        id: "offset",
        title: "Offset pagination",
        benefits: ["Simple page selection"],
        tradeoffs: ["Rows can move across pages"],
        evidence: [
          "No page-number UI requirement occurs in the original request.",
        ],
      },
    ];
    reply.advice!.recommendation = {
      optionId: "cursor",
      rationale:
        "Prefer stable continuation; confirm ordering before implementation.",
    };
    reply.advice!.assumptions = [
      "A stable unique ordering key will be available.",
    ];
    reply.advice!.proposedAmendments = [
      "Clarify ordering and pagination semantics in AC-001.",
    ];
    modify?.(reply);
  });
}

test("advisor records scoped advice on an unfinished contract without adoption or implementation readiness", (t) => {
  const root = fixture(t);
  let s = createSession(root, requirements);
  const draft = example();
  draft.questions = ["Which datastore?"];
  draft.tasks = [];
  s = prepare(
    root,
    s.id,
    draft,
    "planning",
    "Investigate missing information",
    0,
  );
  cancel(root, s.id, "Obtain focused advice first");
  const before = snapshot(root).fingerprint;
  const original = readContract(root, s.id);
  s = issue(root, s.id, "advisor", advisorQuestion, undefined, ["REQ-001"]);
  const roundCount = s.rounds.length;
  const reply = adviceReply(root, s, (r) => {
    r.coverage[0].status = "unverified";
    r.checks[0].outcome = "not_run";
    r.findings = [
      {
        id: "F-1",
        severity: "high",
        description: "Ordering is not defined",
        evidence: "No ordering implementation in app.txt.",
      },
    ];
  });
  assert.deepEqual(
    reply.coverage.map((r) => r.requirementId),
    ["REQ-001"],
  );
  s = ingest(root, s.id);
  s = assess(root, s.id, { ...assessment(s), decision: "noted" });
  assert.equal(s.status, "ADVICE_READY");
  assert.equal(s.rounds.length, roundCount);
  assert.equal(s.rounds.at(-1)!.status, "ASSESSED");
  assert.equal(s.verified, false);
  assert.deepEqual(readContract(root, s.id), original);
  assert.equal(snapshot(root).fingerprint, before);
  assert.deepEqual(recall(root, "", true), []);
  const view = status(root, s.id) as {
    pending: unknown;
    lastAssessment: { advice: Reply["advice"] };
    nextAction: string;
  };
  assert.equal(view.pending, null);
  assert.deepEqual(view.lastAssessment.advice, reply.advice);
  assert.match(view.nextAction, /Nothing was adopted or authorized/);
  assert.equal(ingest(root, s.id).sequence, s.sequence);
  assert.throws(
    () => assess(root, s.id, { ...assessment(s), decision: "noted" }),
    /Only a received/,
  );
  // A deliberate later revision is a separate operation, not an advisor side effect.
  assert.equal(
    prepare(
      root,
      s.id,
      example(),
      "planning",
      "Human chose cursor; revise the plan explicitly",
      1,
    ).contractVersion,
    2,
  );
});

test("advisor requests require an existing contract, valid scope and no pending round", (t) => {
  const root = fixture(t);
  const draft = createSession(root, requirements);
  assert.throws(
    () => issue(root, draft.id, "advisor", advisorQuestion),
    /Prepare a contract/,
  );
  const s = planned(root);
  assert.throws(
    () => issue(root, s.id, "advisor", advisorQuestion),
    /pending request/,
  );
  cancel(root, s.id, "Pause");
  for (const ids of [["UNKNOWN"], ["REQ-001", "REQ-001"], [""]])
    assert.throws(() =>
      issue(root, s.id, "advisor", advisorQuestion, undefined, ids),
    );
  assert.throws(
    () => issue(root, s.id, "advisor", advisorQuestion, "API"),
    /requirement IDs/,
  );
  assert.throws(
    () => issue(root, s.id, "review", "Review", undefined, []),
    /only supported for advisor/,
  );
  assert.throws(
    () => issue(root, s.id, "bogus" as "advisor", advisorQuestion),
    /Unknown request mode/,
  );
  const next = issue(root, s.id, "advisor", advisorQuestion);
  assert.deepEqual(next.rounds.at(-1)!.advisor?.requirementIds, []);
  assert.equal(next.contractVersion, 1);
});

test("advisor response schema validates options and evidence without changing ordinary reply rules", (t) => {
  const root = fixture(t);
  const s = advising(root);
  const valid = adviceReply(root, s);
  assert.deepEqual(validateReply(valid), valid);
  const invalid: ((r: Reply) => void)[] = [
    (r) => {
      delete r.advice;
    },
    (r) => {
      r.advice!.options.pop();
    },
    (r) => {
      r.advice!.options[1].id = r.advice!.options[0].id;
    },
    (r) => {
      r.advice!.recommendation!.optionId = "missing";
    },
    (r) => {
      r.advice!.recommendation = null;
    },
    (r) => {
      r.advice!.options[0].evidence = [];
    },
    (r) => {
      r.advice!.options[0].tradeoffs = [];
    },
    (r) => {
      r.advice!.options[0].benefits = [];
    },
    (r) => {
      Object.assign(r.advice!, { authorizeImplementation: true });
    },
    (r) => {
      r.proposedContract = example();
    },
    (r) => {
      r.mode = "review";
    },
  ];
  for (const modify of invalid) {
    const reply = structuredClone(valid);
    modify(reply);
    assert.throws(() => validateReply(reply));
  }
  const blocked = structuredClone(valid);
  blocked.outcome = "blocked";
  blocked.advice!.options = [];
  blocked.advice!.recommendation = null;
  assert.doesNotThrow(() => validateReply(blocked));
});

test("advisor intake pins the exact question and only the selected requirement coverage", (t) => {
  const root = fixture(t);
  const s = advising(root, ["REQ-002"]);
  adviceReply(root, s, (r) => {
    r.advice!.question = "A different question";
  });
  assert.throws(() => ingest(root, s.id), /question does not match/);
  adviceReply(root, s, (r) => {
    r.coverage[0].requirementId = "REQ-001";
  });
  assert.throws(() => ingest(root, s.id), /assigned scope/);
  adviceReply(root, s, (r) => {
    r.coverage = [];
  });
  assert.throws(() => ingest(root, s.id), /assigned scope/);
  adviceReply(root, s);
  assert.equal(ingest(root, s.id).status, "AWAITING_ASSESSMENT");
});

test("advisor assessment cannot adopt a contract or use ready; noted is advisor-only", (t) => {
  const root = fixture(t);
  let s = advising(root);
  adviceReply(root, s);
  s = ingest(root, s.id);
  assert.throws(
    () => assess(root, s.id, assessment(s)),
    /cannot authorize readiness/,
  );
  assert.throws(
    () =>
      assess(root, s.id, {
        ...assessment(s),
        decision: "noted",
        contract: example(),
      }),
    /cannot change the contract/,
  );
  assert.equal(loadSession(root, s.id).status, "AWAITING_ASSESSMENT");
  assert.equal(readContract(root, s.id).version, 1);
  const p = planned(root);
  respond(root, p);
  ingest(root, p.id);
  assert.throws(
    () => assess(root, p.id, { ...assessment(p), decision: "noted" }),
    /only valid for advisor/,
  );
});

test("incomplete advisor advice requires followup, which preserves scope and previous discussion", (t) => {
  const root = fixture(t);
  let s = advising(root, ["REQ-001"]);
  adviceReply(root, s, (r) => {
    r.outcome = "needs_clarification";
    r.questions = ["What is the expected query volume?"];
    r.advice!.options = [];
    r.advice!.recommendation = null;
  });
  s = ingest(root, s.id);
  assert.throws(
    () => assess(root, s.id, { ...assessment(s), decision: "noted" }),
    /Incomplete advice/,
  );
  const question = "Compare both options assuming 1000 searches per minute.";
  const first = s.rounds.at(-1)!;
  s = assess(root, s.id, {
    ...assessment(s),
    decision: "followup",
    rationale: question,
  });
  const next = s.rounds.at(-1)!;
  assert.equal(next.mode, "advisor");
  assert.notEqual(next.id, first.id);
  assert.deepEqual(next.advisor, { question, requirementIds: ["REQ-001"] });
  assert.equal(s.contractVersion, 1);
  const history = JSON.parse(
    readFileSync(
      join(
        root,
        sessionRelative(s.id),
        roundDirectory(next),
        "conversation.json",
      ),
      "utf8",
    ),
  );
  assert.equal(history.at(-1).advisor.question, advisorQuestion);
  assert.equal(history.at(-1).advice.recommendation, null);
  assert.equal(history.at(-1).decision, "followup");
  adviceReply(root, s);
  s = ingest(root, s.id);
  assert.equal(
    assess(root, s.id, { ...assessment(s), decision: "noted" }).status,
    "ADVICE_READY",
  );
});

test("advisor exports retain question, scope, skills and only current confirmed memory", (t) => {
  const root = fixture(t);
  const active = propose(
    root,
    "Customer search uses account isolation",
    "app.txt",
    "fact",
  );
  curate(root, active.id, "confirm");
  propose(root, "Customer search may need caching", "app.txt", "lesson");
  writeFileSync(join(root, "obsolete.txt"), "old");
  const stale = propose(
    root,
    "Customer search formerly used offsets",
    "obsolete.txt",
    "fact",
  );
  curate(root, stale.id, "confirm");
  writeFileSync(join(root, "obsolete.txt"), "changed");
  const s = advising(root, ["REQ-001"]);
  const path = exportHandoff(root, s.id);
  const template = JSON.parse(
    readFileSync(join(path, "reply.example.json"), "utf8"),
  );
  assert.equal(template.mode, "advisor");
  assert.equal(template.advice.question, advisorQuestion);
  assert.deepEqual(
    template.coverage.map(
      (row: { requirementId: string }) => row.requirementId,
    ),
    ["REQ-001"],
  );
  const memory = JSON.parse(readFileSync(join(path, "memory.json"), "utf8"));
  assert.deepEqual(
    memory.map((entry: { id: string }) => entry.id),
    [active.id],
  );
  const manifest = JSON.parse(
    readFileSync(join(path, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.advisor, s.rounds.at(-1)!.advisor);
  assert.equal(manifest.mode, "advisor");
  assert.ok(existsSync(join(path, "skills/waicc-workflow/SKILL.md")));
  assert.equal(snapshot(root).fingerprint, s.rounds.at(-1)!.source.fingerprint);
});

test("advisor replies become stale before intake or assessment when source changes", (t) => {
  const root = fixture(t);
  let s = advising(root);
  adviceReply(root, s);
  writeFileSync(join(root, "app.txt"), "changed before intake");
  assert.equal(ingest(root, s.id).status, "STALE");
  s = issue(root, s.id, "advisor", advisorQuestion);
  adviceReply(root, s);
  s = ingest(root, s.id);
  writeFileSync(join(root, "app.txt"), "changed after intake");
  assert.throws(
    () => assess(root, s.id, { ...assessment(s), decision: "noted" }),
    /Source changed/,
  );
  assert.equal(ingest(root, s.id).status, "STALE");
});

test("advisor argument parsing and CLI issue a scoped handoff on the existing version", (t) => {
  assert.deepEqual(advisorInput("  A multiline\nquestion?  "), {
    question: "A multiline\nquestion?",
  });
  assert.deepEqual(
    advisorInput("--requirements REQ-001,REQ-002 Which option?"),
    { question: "Which option?", requirementIds: ["REQ-001", "REQ-002"] },
  );
  for (const input of [
    "",
    "--requirements",
    "--requirements REQ-001",
    "--unknown foo",
  ])
    assert.throws(() => advisorInput(input));
  const root = fixture(t);
  const s = planned(root);
  cancel(root, s.id, "Ask for advice");
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve("src/cli.ts"),
        "--root",
        root,
        "advisor",
        s.id,
        "--requirements",
        "REQ-001",
        advisorQuestion,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  assert.equal(result.contractVersion, 1);
  assert.deepEqual(result.rounds.at(-1).advisor, {
    question: advisorQuestion,
    requirementIds: ["REQ-001"],
  });
});

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
  assert.equal(s.status, "READY_TO_CLOSE");
  assert.equal(s.contractReview, "PASS");
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
test("contracts may only name packaged skills, and the error lists them", () => {
  const c = example();
  c.skills = ["react"];
  assert.throws(
    () => validateContract(c, requirements),
    /Unknown skill react\. Available: .*wai-node.*waicc-workflow/,
  );
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

test("flexible external findings preserve original bytes and audit the coordinator's canonical view", (t) => {
  const root = fixture(t),
    s = planned(root);
  const original = respond(root, s);
  const input = {
    ...original,
    findings: [
      {
        severity: "HIGH",
        title: "Authorization concern",
        evidence: ["REQ-002", "AC-001 needs inspection"],
        file: "app.txt",
        line: 1,
      },
    ],
  };
  const dir = roundDirectory(s.rounds[0]);
  const path = join(root, sessionRelative(s.id), dir, "reply.json");
  const raw = json(input);
  writeFileSync(path, raw);
  const received = ingest(root, s.id),
    r = received.rounds[0];
  assert.equal(received.status, "AWAITING_ASSESSMENT");
  assert.equal(received.contractVersion, 1);
  assert.deepEqual(r.reply!.findings, [
    {
      id: "F-001",
      severity: "high",
      description: "Authorization concern",
      evidence: "REQ-002\nAC-001 needs inspection",
      extensions: { file: "app.txt", line: 1 },
    },
  ]);
  assert.equal(readFileSync(path, "utf8"), raw);
  assert.equal(artifact(root, received, `${dir}/received.json`), raw);
  assert.equal(r.replyDigest, digest(raw));
  assert.deepEqual(
    JSON.parse(artifact(root, received, `${dir}/received.normalized.json`)),
    r.reply,
  );
  assert.deepEqual(
    JSON.parse(artifact(root, received, `${dir}/reply-normalization.json`))
      .changes,
    r.replyNormalization,
  );
  assert.ok(r.replyNormalization!.length > 0);
  const view = status(root, s.id) as {
    pending: { reply: Reply; replyNormalization: string[] };
  };
  assert.deepEqual(view.pending.reply.findings, r.reply!.findings);
  assert.deepEqual(view.pending.replyNormalization, r.replyNormalization);
  assert.equal(ingest(root, s.id).sequence, received.sequence);
  assert.throws(() => assess(root, s.id, assessment(received)), /dispositions/);
  const next = assess(root, s.id, {
    ...assessment(received),
    decision: "followup",
    rationale: "Check the concern against the contract and source",
  });
  const history = JSON.parse(
    artifact(
      root,
      next,
      `${roundDirectory(next.rounds.at(-1)!)}/conversation.json`,
    ),
  );
  assert.deepEqual(history[0].findings, r.reply!.findings);
  assert.deepEqual(history[0].replyNormalization, r.replyNormalization);
  assert.equal(loadSession(root, s.id).contractVersion, 1);
});

test("planning intake handles pass and fifteen scalar decision evidence entries with immutable raw/audit records", (t) => {
  const root = fixture(t), s = planned(root), original = respond(root, s);
  const proposed = gatedPlan();
  const input = {
    ...original, outcome: "planned",
    checks: [
      { description: "Read-only source inspection", outcome: "pass", evidence: "Inspected app.txt; not behavioral proof" },
      { description: "Build and tests", outcome: "not_run", evidence: "Planning only; no execution" },
      { description: "Device verification", outcome: "not_run", evidence: "No device access used" },
    ],
    proposedContract: { ...proposed, decisions: Array.from({ length: 15 }, (_, i) => ({
      ...proposed.decisions![0], id: `D${i + 1}`, evidence: `Inspected source for decision ${i + 1}; genuine owner choice remains`,
    })) },
  };
  const dir = roundDirectory(s.rounds[0]),
    path = join(root, sessionRelative(s.id), dir, "reply.json"),
    raw = json(input);
  writeFileSync(path, raw);
  const received = ingest(root, s.id), r = received.rounds[0];
  assert.equal(received.status, "AWAITING_ASSESSMENT");
  assert.equal(received.contractVersion, 1); // Reading a proposal is not adoption.
  assert.equal(r.reply!.checks[0].outcome, "passed");
  assert.deepEqual(r.reply!.checks.slice(1).map((c) => c.outcome), ["not_run", "not_run"]);
  assert.equal(r.replyNormalization!.length, 16);
  assert.equal(readFileSync(path, "utf8"), raw);
  assert.equal(artifact(root, received, `${dir}/received.json`), raw);
  assert.equal(r.replyDigest, digest(raw));
  assert.deepEqual(JSON.parse(artifact(root, received, `${dir}/received.normalized.json`)), r.reply);
  const audit = JSON.parse(artifact(root, received, `${dir}/reply-normalization.json`));
  assert.equal(audit.normalizerVersion, 2);
  assert.deepEqual(audit.changes, r.replyNormalization);
  assert.deepEqual(r.reply!.proposedContract!.decisions!.map((d) => d.evidence), input.proposedContract.decisions.map((d) => [d.evidence]));
  assert.deepEqual(ingest(root, s.id), received);
  const accepted = assess(root, s.id, {
    ...assessment(received), decision: "planned", contract: r.reply!.proposedContract,
  });
  assert.equal(accepted.status, "PLAN_READY");
  assert.equal(accepted.contractVersion, 2);
  assert.equal(accepted.rounds.length, 1);
  assert.equal(accepted.deliveryVerified, false);
  assert.equal(accepted.contractReview, "NOT_REVIEWED");
  assert.equal(readFileSync(path, "utf8"), raw);
});

test("a failure alias is ingested as failed and still prevents planning acceptance", (t) => {
  const root = fixture(t), s = planned(root), original = respond(root, s);
  const path = join(root, sessionRelative(s.id), roundDirectory(s.rounds[0]), "reply.json");
  writeFileSync(path, json({ ...original, outcome: "planned", checks: [{
    name: "Source inspection", result: "FAIL", details: ["A required path is missing"],
  }] }));
  const received = ingest(root, s.id);
  assert.equal(received.rounds[0].reply!.checks[0].outcome, "failed");
  assert.throws(() => assess(root, s.id, { ...assessment(received), decision: "planned" }), /failed checks/);
  assert.deepEqual(loadSession(root, s.id), received);
});

test("normalization cannot bypass reply identity, coverage or source-freshness checks", (t) => {
  const root = fixture(t),
    s = planned(root);
  const original = respond(root, s);
  const input = {
    ...original,
    checks: [{ description: "Read source", outcome: "pass", evidence: ["Inspected source only"] }],
    findings: [{ severity: "low", title: "Concern", evidence: "Source" }],
  };
  const path = join(
    root,
    sessionRelative(s.id),
    roundDirectory(s.rounds[0]),
    "reply.json",
  );
  for (const bad of [
    { ...input, requestId: "other" },
    { ...input, sourceFingerprint: "a".repeat(64) },
    { ...input, coverage: [] },
    { ...input, proposedContract: { ...example(), requirements: [] } },
    { ...input, execute: "some command" },
  ]) {
    writeFileSync(path, json(bad));
    assert.throws(() => ingest(root, s.id));
    assert.equal(loadSession(root, s.id).rounds[0].status, "WAITING");
  }
  writeFileSync(path, json(input));
  writeFileSync(join(root, "app.txt"), "Changed during planning");
  const stale = ingest(root, s.id);
  assert.equal(stale.status, "STALE");
  assert.ok(stale.rounds[0].replyNormalization!.length);
  assert.throws(() => assess(root, s.id, assessment(stale)), /current reply/);
});

test("normalized review evidence is pinned and checked before explicit closure", (t) => {
  const root = fixture(t),
    s = planned(root);
  cancel(root, s.id, "Request full review instead");
  const review = issue(root, s.id, "review", "Review the full contract");
  const original = respond(root, review);
  const dir = roundDirectory(review.rounds.at(-1)!);
  writeFileSync(
    join(root, sessionRelative(s.id), dir, "reply.json"),
    json({
      ...original,
      findings: [
        {
          severity: "info",
          title: "Inspection note",
          evidence: "Source and contract inspected",
        },
      ],
    }),
  );
  const received = ingest(root, s.id);
  assess(root, s.id, assessment(received));
  writeFileSync(
    join(root, sessionRelative(s.id), dir, "received.normalized.json"),
    "tampered",
  );
  assert.throws(
    () => closeSession(root, s.id, "Close discussion"),
    /Artifact was modified/,
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

test("session updatedAt tracks committed activity, not reads, no-op intake or external file timestamps", (t) => {
  const root = fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 17) });
  let s = createSession(root, requirements);
  const createdAt = s.createdAt;
  assert.equal(s.updatedAt, createdAt);
  t.mock.timers.tick(1000);
  s = prepare(root, s.id, example(), "planning", "Inspect", 0);
  assert.equal(s.updatedAt, new Date().toISOString());
  assert.equal(s.createdAt, createdAt);
  const handoffAt = s.updatedAt;
  t.mock.timers.tick(1000);
  assert.equal((status(root, s.id) as Session).updatedAt, handoffAt);
  assert.equal(ingest(root, s.id).updatedAt, handoffAt); // No reply: no event committed.
  assert.throws(
    () => prepare(root, s.id, example(), "planning", "Reject stale version", 0),
    /version changed/,
  );
  assert.equal(loadSession(root, s.id).updatedAt, handoffAt);
  exportHandoff(root, s.id);
  const exportAt = loadSession(root, s.id).updatedAt;
  assert.equal(exportAt, new Date().toISOString());
  t.mock.timers.tick(1000);
  respond(root, s);
  utimesSync(join(root, "app.txt"), new Date(), new Date());
  assert.equal(loadSession(root, s.id).updatedAt, exportAt); // Writing reply.json alone is not intake.
  s = ingest(root, s.id);
  assert.equal(s.updatedAt, new Date().toISOString());
  const receivedAt = s.updatedAt;
  t.mock.timers.tick(1000);
  assert.equal(ingest(root, s.id).updatedAt, receivedAt); // Already received: idempotent.
  s = assess(root, s.id, assessment(s));
  assert.equal(s.updatedAt, new Date().toISOString());
  assert.equal(s.createdAt, createdAt);
  const dir = join(root, sessionRelative(s.id), "journal");
  const last = readdirSync(dir).sort().at(-1)!;
  const entry = JSON.parse(readFileSync(join(dir, last), "utf8"));
  assert.equal(s.updatedAt, entry.at);
  assert.equal(entry.session.updatedAt, entry.at);
});

test("status lists sessions newest activity first and preserves creation times", (t) => {
  const root = fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 17) });
  const first = createSession(root, requirements);
  t.mock.timers.tick(1000);
  const second = createSession(root, "Another objective");
  assert.deepEqual(
    listSessions(root).map((s) => s.id),
    [second.id, first.id],
  );
  t.mock.timers.tick(1000);
  const updated = amend(root, first.id, "Also add pagination.");
  const sessions = listSessions(root);
  assert.deepEqual(
    sessions.map((s) => s.id),
    [first.id, second.id],
  );
  assert.deepEqual(sessions[0], {
    id: first.id,
    status: updated.status,
    createdAt: first.createdAt,
    updatedAt: updated.updatedAt,
    contractReview: updated.contractReview,
    deliveryVerified: false,
  });
  const detail = status(root, first.id) as {
    createdAt: string;
    updatedAt: string;
  };
  assert.equal(detail.createdAt, first.createdAt);
  assert.equal(detail.updatedAt, updated.updatedAt);
  assert.deepEqual(
    (status(root) as { sessions: unknown[] }).sessions,
    sessions,
  );
});

test("equal activity timestamps have deterministic session ordering", (t) => {
  const root = fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 17) });
  const ids = [
    createSession(root, "First objective").id,
    createSession(root, "Second objective").id,
  ];
  assert.deepEqual(
    listSessions(root).map((s) => s.id),
    ids.sort((a, b) => a.localeCompare(b)),
  );
});

test("older sessions recover updatedAt from the journal without rewriting history or trusting the cache", (t) => {
  const root = fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 17) });
  const s = createSession(root, requirements);
  const dir = join(root, sessionRelative(s.id));
  const journal = join(dir, "journal", readdirSync(join(dir, "journal"))[0]);
  const entry = JSON.parse(readFileSync(journal, "utf8"));
  delete entry.session.updatedAt; // Simulate a snapshot written before updatedAt existed.
  const legacy = json(entry);
  writeFileSync(journal, legacy);
  const cache = json({
    ...entry.session,
    updatedAt: "2099-01-01T00:00:00.000Z",
  });
  writeFileSync(join(dir, "session.json"), cache);
  utimesSync(journal, new Date("2099-01-01"), new Date("2099-01-01"));
  t.mock.timers.tick(1000);
  assert.equal(loadSession(root, s.id).updatedAt, entry.at);
  assert.equal(listSessions(root)[0].updatedAt, entry.at);
  assert.equal((status(root, s.id) as Session).updatedAt, entry.at);
  assert.equal(readFileSync(journal, "utf8"), legacy);
  assert.equal(readFileSync(join(dir, "session.json"), "utf8"), cache);
  const updated = amend(root, s.id, "Add pagination.");
  assert.equal(updated.updatedAt, new Date().toISOString());
  assert.equal(updated.createdAt, s.createdAt);
  assert.equal(readFileSync(journal, "utf8"), legacy);
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
  for (let repeat = 0; repeat < 4; repeat++)
    assert.equal(
      snapshot(root).fingerprint,
      before.fingerprint,
      "Identical SVN reads must stay stable",
    );
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
  const changedProperty = snapshot(root);
  assert.notEqual(changedProperty.fingerprint, pinned.fingerprint);
  for (let repeat = 0; repeat < 4; repeat++)
    assert.equal(
      snapshot(root).fingerprint,
      changedProperty.fingerprint,
      "SVN properties must stay stable across reads",
    );
  run(
    "svn",
    ["propset", "custom:property", "different-value", "app.txt"],
    root,
  );
  assert.notEqual(
    snapshot(root).fingerprint,
    changedProperty.fingerprint,
    "A changed property value must be detected even when props status stays modified",
  );
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
  const starter = readFileSync(join(path, "STARTER.txt"), "utf8");
  assert.ok(starter.includes(manifest.requestId));
  assert.ok(starter.includes("HANDOFF.md in the supplied export folder"));
  assert.ok(starter.includes("reply.json beside that HANDOFF.md"));
  assert.ok(starter.includes("matching project checkout"));
  assert.ok(!starter.includes(root));
});

test("manual copy prompts pin each role, resolve linked inputs and leave source/session state unchanged", (t) => {
  for (const mode of [
    "planning",
    "review",
    "advisor",
    "implementation",
  ] as const) {
    const root = fixture(t);
    let s = planned(root);
    if (mode === "implementation") {
      respond(root, s);
      s = ingest(root, s.id);
      s = assess(root, s.id, assessment(s));
    } else if (mode !== "planning") {
      cancel(root, s.id, "Select another recipient mode");
      s = issue(root, s.id, mode, "Perform the assigned work");
    }
    const before = loadSession(root, s.id);
    const r = s.rounds.at(-1)!;
    const view = status(root, s.id) as {
      manualHandoff: ReturnType<typeof manualHandoff>;
    };
    const delivery = view.manualHandoff;
    const starterPath = join(
      root,
      sessionRelative(s.id),
      roundDirectory(r),
      "STARTER.txt",
    );
    assert.equal(delivery.copyPastePrompt, readFileSync(starterPath, "utf8"));
    assert.ok(delivery.copyPastePrompt.includes(r.id));
    assert.ok(delivery.copyPastePrompt.includes(s.id));
    assert.ok(
      delivery.copyPastePrompt.includes(`contract: v${r.contractVersion}`),
    );
    assert.ok(delivery.copyPastePrompt.includes(`WAICC ${mode} recipient`));
    assert.ok(
      delivery.copyPastePrompt.includes(
        JSON.stringify(
          join(root, sessionRelative(s.id), roundDirectory(r), "HANDOFF.md"),
        ),
      ),
    );
    assert.ok(
      delivery.copyPastePrompt.includes(
        JSON.stringify(
          join(root, sessionRelative(s.id), roundDirectory(r), "reply.json"),
        ),
      ),
    );
    assert.ok(!delivery.copyPastePrompt.includes("/waicc-continue"));
    assert.equal(delivery.resumeCoordinatorCommand, `/waicc-use ${s.id}`);
    assert.equal(delivery.continueCommand, "/waicc-continue");
    assert.deepEqual(loadSession(root, s.id), before);
    assert.equal(snapshot(root).fingerprint, r.source.fingerprint);
  }
});

test("manual handoff view is withheld once any reply exists and never reissues work", (t) => {
  const root = fixture(t),
    s = planned(root);
  const initial = status(root, s.id) as {
    manualHandoff: unknown;
    pending: { replyExists: boolean };
  };
  assert.ok(initial.manualHandoff);
  assert.equal(initial.pending.replyExists, false);
  const before = loadSession(root, s.id);
  respond(root, s);
  const written = status(root, s.id) as {
    manualHandoff: unknown;
    pending: { replyExists: boolean };
    nextAction: string;
  };
  assert.equal(written.manualHandoff, null);
  assert.equal(written.pending.replyExists, true);
  assert.match(written.nextAction, /already exists.*waicc-continue/);
  assert.deepEqual(loadSession(root, s.id), before);
  ingest(root, s.id);
  assert.equal(
    (status(root, s.id) as { manualHandoff: unknown }).manualHandoff,
    null,
  );
  cancel(root, s.id, "Stop the exchange");
  assert.equal(
    (status(root, s.id) as { manualHandoff: unknown }).manualHandoff,
    null,
  );
});

test("manual copy block stays intact when a prompt path contains Markdown fence characters", (t) => {
  const root = fixture(t),
    s = planned(root);
  const delivery = (
    status(root, s.id) as { manualHandoff: ReturnType<typeof manualHandoff> }
  ).manualHandoff;
  delivery.copyPastePrompt += "Path data containing ```` backticks\n";
  const message = manualHandoffMessage(delivery);
  const match = /^(`{3,})text\n([\s\S]*?)\n\1$/m.exec(message)!;
  assert.ok(match);
  assert.equal(match[2] + "\n", delivery.copyPastePrompt);
  assert.ok(match[1].length > 4);
  assert.ok(!match[2].includes("/waicc-continue"));
  assert.ok(
    message
      .slice(message.indexOf(match[0]) + match[0].length)
      .includes(delivery.continueCommand),
  );
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
  assert.equal(recovered.createdAt, s.createdAt);
  assert.equal(recovered.updatedAt, s.updatedAt);
  assert.equal(invoke("status", "all").sessions.length, 1);
  assert.equal(invoke("status", "all").sessions[0].updatedAt, s.updatedAt);
  const bad = spawnSync(
    process.execPath,
    [cli, "--root", root, "status", "0000-missing"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown WAICC session 0000-missing/);
  const unknown = spawnSync(process.execPath, [cli, "bogus"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(unknown.status, 2);
});
