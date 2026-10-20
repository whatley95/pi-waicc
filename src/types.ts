export type Mode = "planning" | "review" | "implementation" | "testing" | "advisor";
export type Objective = "planning" | "development" | "review";
export type RoundPhase = "specification" | "implementation" | "testing" | "code_review" | "advisor";
export type SessionStatus =
  | "DRAFT"
  | "WAITING_FOR_REPLY"
  | "AWAITING_ASSESSMENT"
  | "NEEDS_CLARIFICATION"
  | "NEEDS_CHANGES"
  | "STALE"
  | "BLOCKED"
  | "READY_FOR_HANDOFF"
  | "PLAN_READY"
  | "SPEC_APPROVED"
  | "READY_TO_IMPLEMENT"
  | "IMPLEMENTATION_GATED"
  | "ADVICE_READY"
  | "READY_TO_CLOSE"
  | "CLOSED"
  | "NEEDS_TESTING"
  | "NEEDS_REVIEW";
export type ContractReview =
  "NOT_REVIEWED" | "PENDING" | "PASS" | "NEEDS_CHANGES" | "BLOCKED" | "STALE";
export interface ReviewApproval {
  kind?: "code" | "contract";
  requestId: string;
  contractVersion: number;
  requirementsDigest: string;
  sourceFingerprint: string;
  assessedAt: string;
}
interface ClosureRecord {
  id: string;
  closedAt: string;
  reason: string;
}
export type Closure = ClosureRecord &
  (
    | { kind?: "reviewed"; approval: ReviewApproval }
    | { kind: "forced"; approval?: never; cancelledRequestIds: string[] }
  );
export interface Requirement {
  id: string;
  text: string;
  sourceQuote: string;
}
export interface Criterion {
  id: string;
  text: string;
  requirementIds: string[];
  verification: string;
}
export interface Task {
  id: string;
  title: string;
  requirementIds: string[];
  dependsOn: string[];
  allowedPaths: string[];
  acceptance: Criterion[];
}
export interface Contract {
  title: string;
  requirements: Requirement[];
  exclusions: string[];
  assumptions: string[];
  questions: string[];
  risks: string[];
  tasks: Task[];
  skills: string[];
  decisions?: ContractDecision[];
}
export interface ContractDecision {
  id: string;
  question: string;
  owner: "agent" | "human" | "external";
  status: "open" | "resolved" | "deferred";
  affectedTaskIds: string[];
  evidence: string[];
  recommendation: string;
  answer?: string;
  /** How much a wrong answer would cost; low only when reversible, in scope and not sensitive. */
  risk?: "low" | "medium" | "high";
  /** Whether the answer can be changed later without lasting effect. */
  reversible?: boolean;
}
export interface SourceSnapshot {
  vcs: "git" | "svn" | "none";
  revision: string | null;
  fingerprint: string;
  files: Record<string, string>;
  vcsState?: string;
}
export interface ContractVersion {
  schemaVersion: 1;
  sessionId: string;
  version: number;
  createdAt: string;
  requirementsDigest: string;
  source: SourceSnapshot;
  contract: Contract;
}
export interface Reply {
  schemaVersion: 1;
  sessionId: string;
  requestId: string;
  contractVersion: number;
  requirementsDigest: string;
  sourceFingerprint: string;
  mode: Mode;
  outcome:
    "ready" | "planned" | "needs_changes" | "needs_clarification" | "blocked";
  summary: string;
  coverage: {
    requirementId: string;
    status: "addressed" | "missing" | "unverified";
    evidence: string;
  }[];
  findings: {
    id: string;
    severity: "critical" | "high" | "medium" | "low" | "info";
    description: string;
    evidence: string;
    suggestedFix?: string;
    extensions?: Record<string, unknown>;
  }[];
  questions: string[];
  checks: {
    description: string;
    outcome: "passed" | "failed" | "not_run";
    evidence: string;
    extensions?: Record<string, unknown>;
  }[];
  proposedContract?: Contract;
  completion?: WorkCompletion;
  advice?: {
    question: string;
    options: {
      id: string;
      title: string;
      benefits: string[];
      tradeoffs: string[];
      evidence: string[];
    }[];
    recommendation: { optionId: string; rationale: string } | null;
    assumptions: string[];
    proposedAmendments: string[];
  };
}
export interface Round {
  id: string;
  mode: Mode;
  phase?: RoundPhase;
  contractVersion: number;
  taskId: string | null;
  advisor?: { question: string; requirementIds: string[] };
  contextVersion?: 1;
  checkpointVersion?: 1;
  wholeWork?: true;
  review?:
    | { kind: "contract" }
    | {
        kind: "code";
        base: SourceSnapshot;
        changedPaths: string[];
        completion: WorkCompletion;
        /** A review of an existing change: its range, and the patch and commits beside the handoff. */
        revision?: RevisionReview & {
          changedPaths: string[]; truncated: boolean; patchBytes: number; checkout: string | null;
          /** Per-folder patches in changes/, for a large change across several folders. */
          parts?: { folder: string; file: string; paths: number; truncated: boolean }[];
        };
      };
  source: SourceSnapshot;
  requirementsDigest: string;
  status: "WAITING" | "RECEIVED" | "ASSESSED" | "STALE" | "CANCELLED";
  replyDigest?: string;
  reply?: Reply;
  replyNormalization?: string[];
  decision?: string;
  rationale?: string;
  dispositions?: {
    findingId: string;
    disposition: "resolved" | "disputed";
    evidence: string;
  }[];
}
/** Coordinator claims for independent review, never proof of delivery. */
export interface WorkCompletion {
  summary: string;
  tasks: { taskId: string; evidence: string }[];
  checks: {
    description: string;
    outcome: "passed" | "failed" | "not_run";
    evidence: string;
    extensions?: Record<string, unknown>;
  }[];
  findings: {
    requestId: string;
    findingId: string;
    disposition: "resolved" | "disputed";
    evidence: string;
  }[];
}
export interface RecipientPin {
  sessionId: string;
  requestId: string;
  contractVersion: number;
  requirementsDigest: string;
  sourceFingerprint: string;
  mode: Mode;
}
export interface Session {
  schemaVersion: 1;
  id: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  requirements: string[];
  contractVersion: number;
  status: SessionStatus;
  rounds: Round[];
  artifacts: Record<string, string>;
  maxRounds: number;
  objective?: Objective;
  autoPlanning?: { chatId: string; requestId: string; requirementsDigest: string };
  roundLimits?: Partial<Record<RoundPhase, number>>;
  contractReview: ContractReview;
  implementationOwner?: "main" | "delegate";
  planApproval?: { contractVersion: number; requirementsDigest: string; requestId: string } | null;
  testingOwner?: "main" | "delegate";
  implementationAuthorization?: {
    id: string; contractVersion: number; requirementsDigest: string; allowedPathsDigest: string;
    sourceFingerprint: string; grantedAt: string; artifactPath: string;
    origin: "human-develop" | "human-dispatch-develop" | "human-implementation-delegation" | "human-decision-resolution";
  };
  context?: { summary: string; updatedAt: string; artifactPath: string };
  checkpoint?: { jsonPath: string; markdownPath: string; sequence: number };
  reviewApproval?: ReviewApproval;
  closure?: Closure;
  /** Set by /waicc-review --rev: every code review in this session covers this change. */
  revisionReview?: RevisionReview;
  deliveryVerified: false;
  verified: false;
}
export interface MemoryEntry {
  id: string;
  kind: "fact" | "decision" | "lesson";
  text: string;
  source: string;
  sourceDigest: string;
  createdAt: string;
  confirmedAt: string | null;
  revoked: boolean;
  /** A lesson learned from review findings that recur across sessions: the findings it rests on. */
  evidence?: FindingRef[];
}
/** A Git commit or range, or SVN revisions, resolved when the review was requested. */
export interface RevisionReview {
  vcs: "git" | "svn";
  range: string;
  from: string;
  to: string;
  label: string;
  /** Set for /waicc-review --mr: where it was fetched from and into which branch it merges. */
  mergeRequest?: { remote: string; number: number; provider: "gitlab" | "github"; target: string; url: string | null; head: string };
}
export interface FindingRef {
  sessionId: string;
  requestId: string;
  findingId: string;
}
