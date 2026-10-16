export type Mode = "planning" | "review" | "implementation";
export type SessionStatus =
  | "DRAFT"
  | "WAITING_FOR_REPLY"
  | "AWAITING_ASSESSMENT"
  | "NEEDS_CLARIFICATION"
  | "NEEDS_CHANGES"
  | "STALE"
  | "BLOCKED"
  | "READY_FOR_HANDOFF"
  | "NEEDS_REVIEW";
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
  outcome: "ready" | "needs_changes" | "needs_clarification" | "blocked";
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
  }[];
  questions: string[];
  checks: {
    description: string;
    outcome: "passed" | "failed" | "not_run";
    evidence: string;
  }[];
  proposedContract?: Contract;
}
export interface Round {
  id: string;
  mode: Mode;
  contractVersion: number;
  taskId: string | null;
  source: SourceSnapshot;
  requirementsDigest: string;
  status: "WAITING" | "RECEIVED" | "ASSESSED" | "STALE" | "CANCELLED";
  replyDigest?: string;
  reply?: Reply;
  decision?: string;
  rationale?: string;
  dispositions?: {
    findingId: string;
    disposition: "resolved" | "disputed";
    evidence: string;
  }[];
}
export interface Session {
  schemaVersion: 1;
  id: string;
  projectRoot: string;
  createdAt: string;
  sequence: number;
  requirements: string[];
  contractVersion: number;
  status: SessionStatus;
  rounds: Round[];
  artifacts: Record<string, string>;
  maxRounds: number;
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
}
