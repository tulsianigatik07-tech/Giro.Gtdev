import type {
  IndexingJob,
  IndexingJobFailure,
  IndexingJobStage,
  IndexingJobStatus,
} from "./indexingJobStore.js";

export interface IndexingJobPersistenceRow {
  job_id: string;
  repository_id: string;
  owner_user_id: string;
  repository_owner: string;
  repository_name: string;
  repository_url: string;
  branch: string | null;
  status: IndexingJobStatus;
  sequence: number;
  attempt: number;
  max_attempts: number;
  progress: number;
  current_stage: IndexingJobStage;
  failure_code: string | null;
  failure_message: string | null;
  failure_retryable: boolean | null;
  claimed_by: string | null;
  created_order: number;
  started_order: number | null;
  completed_order: number | null;
  request_id?: string | null;
  traceparent?: string | null;
  created_at?: string;
  updated_at?: string;
  claimed_at?: string | null;
  started_at?: string | null;
  heartbeat_at?: string | null;
  lease_expires_at?: string | null;
  last_progress_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
  next_retry_at?: string | null;
  recovery_count?: number;
}

export type IndexingJobInsertRow = Omit<
  IndexingJobPersistenceRow,
  "created_at" | "updated_at"
>;

export type IndexingJobUpdateRow = Pick<
  IndexingJobPersistenceRow,
  | "status"
  | "attempt"
  | "max_attempts"
  | "progress"
  | "current_stage"
  | "failure_code"
  | "failure_message"
  | "failure_retryable"
  | "claimed_by"
  | "started_order"
  | "completed_order"
>;

function failureColumns(failure: IndexingJobFailure | null): {
  failure_code: string | null;
  failure_message: string | null;
  failure_retryable: boolean | null;
} {
  return failure
    ? {
        failure_code: failure.code,
        failure_message: failure.message,
        failure_retryable: failure.retryable,
      }
    : {
        failure_code: null,
        failure_message: null,
        failure_retryable: null,
      };
}

export function indexingJobToInsertRow(job: IndexingJob): IndexingJobInsertRow {
  return {
    job_id: job.jobId,
    repository_id: job.repositoryId,
    owner_user_id: job.ownerUserId,
    repository_owner: job.repositoryOwner,
    repository_name: job.repositoryName,
    repository_url: job.repositoryUrl,
    branch: job.branch ?? null,
    status: job.status,
    sequence: job.sequence,
    attempt: job.attempt,
    max_attempts: job.maxAttempts,
    progress: job.progress,
    current_stage: job.currentStage,
    ...failureColumns(job.failure),
    claimed_by: job.claimedBy ?? null,
    created_order: job.createdOrder,
    started_order: job.startedOrder ?? null,
    completed_order: job.completedOrder ?? null,
    ...(job.createdByRequestId
      ? { request_id: job.createdByRequestId }
      : {}),
    ...(job.createdByTraceparent
      ? { traceparent: job.createdByTraceparent }
      : {}),
  };
}

export function indexingJobToUpdateRow(job: IndexingJob): IndexingJobUpdateRow {
  return {
    status: job.status,
    attempt: job.attempt,
    max_attempts: job.maxAttempts,
    progress: job.progress,
    current_stage: job.currentStage,
    ...failureColumns(job.failure),
    claimed_by: job.claimedBy ?? null,
    started_order: job.startedOrder ?? null,
    completed_order: job.completedOrder ?? null,
  };
}

export function indexingJobRowToDomain(row: IndexingJobPersistenceRow): IndexingJob {
  let failure: IndexingJobFailure | null = null;
  const hasFailureColumn = row.failure_code !== null
    || row.failure_message !== null
    || row.failure_retryable !== null;
  if (hasFailureColumn) {
    if (
      row.failure_code === null
      || row.failure_message === null
      || row.failure_retryable === null
    ) {
      throw new Error("Invalid persisted indexing job failure.");
    }
    failure = {
      code: row.failure_code,
      message: row.failure_message,
      retryable: row.failure_retryable,
    };
  }

  return {
    jobId: row.job_id,
    repositoryId: row.repository_id,
    ownerUserId: row.owner_user_id,
    repositoryOwner: row.repository_owner,
    repositoryName: row.repository_name,
    repositoryUrl: row.repository_url,
    branch: row.branch ?? null,
    status: row.status,
    sequence: row.sequence,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    progress: row.progress,
    currentStage: row.current_stage,
    failure,
    claimedBy: row.claimed_by ?? null,
    createdOrder: row.created_order,
    startedOrder: row.started_order ?? null,
    completedOrder: row.completed_order ?? null,
    ...(row.request_id ? { createdByRequestId: row.request_id } : {}),
    ...(row.traceparent ? { createdByTraceparent: row.traceparent } : {}),
    ...(row.claimed_at !== undefined ? { claimedAt: row.claimed_at } : {}),
    ...(row.started_at !== undefined ? { startedAt: row.started_at } : {}),
    ...(row.heartbeat_at !== undefined ? { heartbeatAt: row.heartbeat_at } : {}),
    ...(row.lease_expires_at !== undefined ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.last_progress_at !== undefined ? { lastProgressAt: row.last_progress_at } : {}),
    ...(row.completed_at !== undefined ? { completedAt: row.completed_at } : {}),
    ...(row.failed_at !== undefined ? { failedAt: row.failed_at } : {}),
    ...(row.next_retry_at !== undefined ? { nextRetryAt: row.next_retry_at } : {}),
    ...(row.recovery_count !== undefined ? { recoveryCount: row.recovery_count } : {}),
  };
}
