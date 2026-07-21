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

export interface StaleIndexingJobRecoveryInput {
  staleBefore: string;
  leaseExpiresBefore?: string;
  retryDelayMs: number;
}

export interface SupervisedIndexingJobStore extends IndexingJobStore {
  heartbeatJob(jobId: string, workerId: string, leaseDurationMs?: number): Promise<boolean>;
  scheduleRetry(
    jobId: string,
    workerId: string,
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
  createJob(input: CreateIndexingJobInput): Promise<IndexingJob>;
  getJob(jobId: string): Promise<IndexingJob | null>;
  listJobs(filters?: IndexingJobListFilters): Promise<IndexingJob[]>;
  listRepositoryJobs(repositoryId: string): Promise<IndexingJob[]>;
  getLatestRepositoryJob(repositoryId: string): Promise<IndexingJob | null>;
  claimNextJob(workerId: string, leaseDurationMs?: number): Promise<IndexingJob | null>;
  updateJob(jobId: string, patch: IndexingJobPatch): Promise<IndexingJob | null>;
  markRunning(jobId: string, stage?: IndexingJobStage, workerId?: string): Promise<IndexingJob | null>;
  updateProgress(
    jobId: string,
    progress: number,
    stage?: IndexingJobStage,
    workerId?: string,
  ): Promise<IndexingJob | null>;
  markSucceeded(jobId: string, workerId?: string): Promise<IndexingJob | null>;
  markFailed(
    jobId: string,
    failure: IndexingJobFailure,
    workerId?: string,
  ): Promise<IndexingJob | null>;
  cancelJob(jobId: string): Promise<IndexingJob | null>;
  deleteJob(jobId: string): Promise<boolean>;
  clear(): Promise<void>;
}
