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
}

export interface CreateIndexingJobInput {
  repositoryId: string;
  ownerUserId: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryUrl: string;
  branch?: string | null;
  maxAttempts?: number;
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
  claimNextJob(workerId: string): Promise<IndexingJob | null>;
  updateJob(jobId: string, patch: IndexingJobPatch): Promise<IndexingJob | null>;
  markRunning(jobId: string, stage?: IndexingJobStage): Promise<IndexingJob | null>;
  updateProgress(
    jobId: string,
    progress: number,
    stage?: IndexingJobStage,
  ): Promise<IndexingJob | null>;
  markSucceeded(jobId: string): Promise<IndexingJob | null>;
  markFailed(
    jobId: string,
    failure: IndexingJobFailure,
  ): Promise<IndexingJob | null>;
  cancelJob(jobId: string): Promise<IndexingJob | null>;
  deleteJob(jobId: string): Promise<boolean>;
  clear(): Promise<void>;
}
