import type { RepositoryPlanRecord } from "../repositoryPlanning/types.js";

export const REPOSITORY_EXECUTION_VERSION = "repository-execution-v1";
export const REPOSITORY_EXECUTION_SCHEMA_VERSION = "repository-execution-schema-v1";

export type ExecutionPolicy =
  | "review_only"
  | "dry_run"
  | "agent_assisted"
  | "guarded_execution";

export type ExecutionRunStatus =
  | "queued"
  | "planning"
  | "awaiting_approval"
  | "approved"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

export type WorkUnitStatus =
  | "blocked"
  | "ready"
  | "leased"
  | "running"
  | "awaiting_review"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export interface ExecutionRetryPolicy {
  maxAttempts: number;
  retryableFailureCodes: string[];
}

export interface ExecutionWorkUnit {
  workUnitId: string;
  phaseId: string;
  order: number;
  objective: string;
  affectedFiles: string[];
  affectedSymbols: string[];
  allowedOperations: string[];
  forbiddenOperations: string[];
  prerequisites: string[];
  validationCommands: string[];
  expectedOutputs: string[];
  rollbackInstructions: string[];
  riskScore: number;
  approvalRequired: boolean;
  retryPolicy: ExecutionRetryPolicy;
  parallelSafe: boolean;
  criticalPathRank: number;
}

export interface WorkUnitState extends ExecutionWorkUnit {
  status: WorkUnitStatus;
  attempt: number;
  outputVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionApproval {
  approvalId: string;
  scope: "run" | "work_units";
  workUnitIds: string[];
  decision: "approved" | "rejected";
  ownerId: string;
  executionVersion: string;
  repositoryRevision: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface WorkUnitLease {
  workUnitId: string;
  workerId: string;
  claimToken: string;
  attempt: number;
  claimedAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

export interface AgentWorkUnitOutput {
  summary: string;
  filesConsidered: string[];
  proposedChanges: Array<{
    file: string;
    operation: "create" | "modify" | "delete" | "none";
    description: string;
  }>;
  commandsProposed: string[];
  testsProposed: string[];
  risksDiscovered: string[];
  blockers: string[];
  artifacts: Array<{ kind: string; uri: string; digest?: string }>;
  completionStatus: "completed" | "blocked" | "failed";
}

export interface VersionedAgentOutput {
  workUnitId: string;
  outputVersion: number;
  attempt: number;
  workerId: string;
  payloadHash: string;
  output: AgentWorkUnitOutput;
  createdAt: string;
}

export type ReviewVerdict = "approved" | "changes_requested" | "rejected" | "skipped";

export interface WorkUnitReview {
  reviewId: string;
  workUnitId: string;
  reviewerId: string;
  reviewerType: "human" | "agent" | "system";
  verdict: ReviewVerdict;
  findings: string[];
  requiredCorrections: string[];
  reviewedOutputVersion: number;
  idempotencyKey: string;
  createdAt: string;
}

export interface ExecutionDiagnostic {
  code: string;
  message: string;
  workUnitId?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface ExecutionRun {
  executionId: string;
  executionVersion: string;
  schemaVersion: string;
  orchestratorVersion: string;
  ownerId: string;
  repositoryId: string;
  repositoryRevision: string;
  sourcePlanId: string;
  sourcePlanVersion: string;
  policy: ExecutionPolicy;
  userConstraints: Record<string, unknown>;
  status: ExecutionRunStatus;
  workUnits: WorkUnitState[];
  criticalPath: string[];
  approvalState: "not_required" | "pending" | "partial" | "approved" | "rejected";
  approvals: ExecutionApproval[];
  leases: WorkUnitLease[];
  outputs: VersionedAgentOutput[];
  reviews: WorkUnitReview[];
  diagnostics: ExecutionDiagnostic[];
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExecutionCreationInput {
  ownerId: string;
  planOwnerId: string;
  repositoryOwnerId: string;
  repositoryId: string;
  repositoryRevision: string;
  plan: RepositoryPlanRecord;
  policy: ExecutionPolicy;
  userConstraints?: Record<string, unknown>;
  idempotencyKey: string;
  repositoryDeleted?: boolean;
  guardedExecutionEnabled?: boolean;
}

export interface ExecutionQuotas {
  activeRunsPerUser: number;
  workUnitsPerRun: number;
  concurrentLeasesPerUser: number;
  attemptsPerWorkUnit: number;
  outputBytes: number;
  executionDurationMs: number;
  retainedRuns: number;
}

export interface ExecutionListPage {
  runs: ExecutionRun[];
  nextCursor: string | null;
}

export class ExecutionOrchestratorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ExecutionOrchestratorError";
  }
}
