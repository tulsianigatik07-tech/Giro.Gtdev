export type IndexingJobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type IndexingJobStage =
  | "pending"
  | "clone"
  | "scan"
  | "structure"
  | "symbols"
  | "graph"
  | "chunk"
  | "embed"
  | "finalize"
  | "complete";

export interface IndexingJobFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface IndexingJob {
  jobId: string;
  repositoryId: string;
  ownerUserId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryUrl: string;
  branch: string | null;
  status: IndexingJobStatus;
  sequence: number;
  attempt: number;
  maxAttempts: number;
  progress: number;
  currentStage: IndexingJobStage;
  failure: IndexingJobFailure | null;
  claimedBy: string | null;
  claimToken: string | null;
  createdOrder: number;
  startedOrder: number | null;
  completedOrder: number | null;
  claimedAt?: string | null;
  startedAt?: string | null;
  heartbeatAt?: string | null;
  leaseExpiresAt?: string | null;
  lastProgressAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  nextRetryAt?: string | null;
  recoveryCount?: number;
  createdByRequestId?: string;
  createdByTraceparent?: string;
}

export const INDEXING_JOB_LEASE_CONFLICT = "indexing_job_lease_conflict" as const;

export class IndexingJobLeaseConflictError extends Error {
  readonly code = INDEXING_JOB_LEASE_CONFLICT;

  constructor() {
    super("Indexing job lease authority was lost.");
    this.name = "IndexingJobLeaseConflictError";
  }
}

export interface IndexingJobClaim {
  workerId: string;
  claimToken: string;
}

export function indexingJobClaim(job: IndexingJob): IndexingJobClaim {
  if (!job.claimedBy || !job.claimToken) throw new IndexingJobLeaseConflictError();
  return Object.freeze({ workerId: job.claimedBy, claimToken: job.claimToken });
}

export interface StaleIndexingJobRecoveryInput {
  staleBefore: string;
  leaseExpiresBefore?: string;
  retryDelayMs: number;
}

export interface SupervisedIndexingJobStore extends IndexingJobStore {
  heartbeatJob(jobId: string, claim: IndexingJobClaim, leaseDurationMs?: number): Promise<boolean>;
  scheduleRetry(
    jobId: string,
    claim: IndexingJobClaim,
    failure: IndexingJobFailure,
    delayMs: number,
  ): Promise<IndexingJob | null>;
  recoverStaleJobs(input: StaleIndexingJobRecoveryInput): Promise<IndexingJob[]>;
}

export interface CreateIndexingJobInput {
  repositoryId: string;
  ownerUserId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryUrl: string;
  branch?: string | null;
  maxAttempts?: number;
  createdByRequestId?: string;
  createdByTraceparent?: string;
}

export interface IndexingJobListFilters {
  status?: IndexingJobStatus;
  repositoryId?: string;
  ownerUserId?: string;
}

export interface IndexingJobPatch {
  progress?: number;
  currentStage?: IndexingJobStage;
  failure?: IndexingJobFailure | null;
  maxAttempts?: number;
}

export interface IndexingJobStore {
  readonly repositoryStateHandledByJobStore?: boolean;
  createJob(input: CreateIndexingJobInput): Promise<IndexingJob>;
  getJob(jobId: string): Promise<IndexingJob | null>;
  listJobs(filters?: IndexingJobListFilters): Promise<IndexingJob[]>;
  listRepositoryJobs(repositoryId: string): Promise<IndexingJob[]>;
  getLatestRepositoryJob(repositoryId: string): Promise<IndexingJob | null>;
  claimNextJob(workerId: string, leaseDurationMs?: number): Promise<IndexingJob | null>;
  updateJob(jobId: string, patch: IndexingJobPatch, claim?: IndexingJobClaim): Promise<IndexingJob | null>;
  markRunning(jobId: string, stage?: IndexingJobStage, claim?: IndexingJobClaim): Promise<IndexingJob | null>;
  updateProgress(
    jobId: string,
    progress: number,
    stage?: IndexingJobStage,
    claim?: IndexingJobClaim,
  ): Promise<IndexingJob | null>;
  markSucceeded(jobId: string, claim?: IndexingJobClaim): Promise<IndexingJob | null>;
  markFailed(
    jobId: string,
    failure: IndexingJobFailure,
    claim?: IndexingJobClaim,
  ): Promise<IndexingJob | null>;
  cancelJob(jobId: string, claim?: IndexingJobClaim): Promise<IndexingJob | null>;
  deleteJob(jobId: string): Promise<boolean>;
  clear(): Promise<void>;
}
