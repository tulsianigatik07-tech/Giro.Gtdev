import type {
  IndexingJob,
  IndexingJobFailure,
  IndexingJobStage,
  IndexingJobStatus,
} from "./indexingJobStore.js";

export interface IndexingJobLifecycleError {
  code: string;
  message: string;
}

export type IndexingJobTransitionResult =
  | { ok: true; job: IndexingJob }
  | { ok: false; error: IndexingJobLifecycleError };

export const ACTIVE_INDEXING_JOB_STATUSES: readonly IndexingJobStatus[] = [
  "queued",
  "claimed",
  "running",
];

const TRANSITIONS: Record<IndexingJobStatus, readonly IndexingJobStatus[]> = {
  queued: ["claimed", "cancelled"],
  claimed: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: ["queued"],
  cancelled: [],
};

function cloneFailure(failure: IndexingJobFailure | null): IndexingJobFailure | null {
  return failure ? { ...failure } : null;
}

export function cloneIndexingJob(job: IndexingJob): IndexingJob {
  return {
    ...job,
    failure: cloneFailure(job.failure),
  };
}

export function listAllowedIndexingJobTransitions(
  status: IndexingJobStatus,
): IndexingJobStatus[] {
  return [...TRANSITIONS[status]];
}

export function canTransitionIndexingJob(
  currentStatus: IndexingJobStatus,
  nextStatus: IndexingJobStatus,
): boolean {
  return TRANSITIONS[currentStatus].includes(nextStatus);
}

export function isActiveIndexingJobStatus(status: IndexingJobStatus): boolean {
  return ACTIVE_INDEXING_JOB_STATUSES.includes(status);
}

export function canRetryIndexingJob(job: IndexingJob): boolean {
  return (
    job.status === "failed" &&
    job.failure?.retryable === true &&
    job.attempt < job.maxAttempts
  );
}

export function isValidIndexingJobProgress(progress: number): boolean {
  return Number.isInteger(progress) && progress >= 0 && progress <= 100;
}

export function validateIndexingJobProgress(
  job: IndexingJob,
  progress: number,
): IndexingJobLifecycleError | null {
  if (!isValidIndexingJobProgress(progress)) {
    return {
      code: "invalid_progress",
      message: "Progress must be an integer from 0 to 100",
    };
  }

  if (progress < job.progress) {
    return {
      code: "progress_decreased",
      message: "Progress cannot decrease",
    };
  }

  if (job.status !== "succeeded" && progress === 100) {
    return {
      code: "incomplete_progress_complete",
      message: "Progress cannot be 100 until the job succeeds",
    };
  }

  return null;
}

export interface TransitionIndexingJobOptions {
  stage?: IndexingJobStage;
  progress?: number;
  failure?: IndexingJobFailure | null;
  order?: number | null;
  workerId?: string | null;
}

export function transitionIndexingJob(
  job: IndexingJob,
  nextStatus: IndexingJobStatus,
  options: TransitionIndexingJobOptions = {},
): IndexingJobTransitionResult {
  if (job.status === nextStatus) {
    return {
      ok: false,
      error: {
        code: "invalid_transition",
        message: `Cannot transition indexing job from ${job.status} to ${nextStatus}`,
      },
    };
  }

  if (job.status === "failed" && nextStatus === "queued") {
    if (!canRetryIndexingJob(job)) {
      return {
        ok: false,
        error: {
          code: "retry_not_allowed",
          message: "Failed indexing job cannot be retried",
        },
      };
    }
  } else if (!canTransitionIndexingJob(job.status, nextStatus)) {
    return {
      ok: false,
      error: {
        code: "invalid_transition",
        message: `Cannot transition indexing job from ${job.status} to ${nextStatus}`,
      },
    };
  }

  const retrying = nextStatus === "queued" && job.status === "failed";
  const progress = nextStatus === "succeeded"
    ? 100
    : retrying ? 0 : (options.progress ?? job.progress);
  const progressError = validateIndexingJobProgress(
    nextStatus === "succeeded" ? { ...job, status: "succeeded" } : job,
    progress,
  );
  if (progressError) {
    return { ok: false, error: progressError };
  }

  return {
    ok: true,
    job: {
      ...cloneIndexingJob(job),
      status: nextStatus,
      attempt: retrying
        ? job.attempt + 1
        : job.attempt,
      progress,
      currentStage: retrying
        ? "pending"
        : options.stage ?? (nextStatus === "succeeded" ? "complete" : job.currentStage),
      failure:
        nextStatus === "failed"
          ? cloneFailure(options.failure ?? null)
          : nextStatus === "queued"
            ? null
            : cloneFailure(job.failure),
      claimedBy:
        nextStatus === "claimed"
          ? (options.workerId ?? job.claimedBy)
          : nextStatus === "queued" || nextStatus === "cancelled"
            ? null
            : job.claimedBy,
      startedOrder:
        retrying
          ? null
          : nextStatus === "claimed" || nextStatus === "running"
          ? (job.startedOrder ?? options.order ?? null)
          : job.startedOrder,
      completedOrder:
        retrying
          ? null
          : nextStatus === "succeeded" || nextStatus === "failed" || nextStatus === "cancelled"
          ? (options.order ?? job.completedOrder)
          : job.completedOrder,
    },
  };
}
