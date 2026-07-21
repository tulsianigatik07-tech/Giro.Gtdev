import {
  cloneIndexingJob,
  isActiveIndexingJobStatus,
  transitionIndexingJob,
  validateIndexingJobProgress,
} from "./indexingJobLifecycle.js";
import type {
  CreateIndexingJobInput,
  IndexingJob,
  IndexingJobFailure,
  IndexingJobListFilters,
  IndexingJobPatch,
  IndexingJobStage,
  IndexingJobStore,
  StaleIndexingJobRecoveryInput,
  SupervisedIndexingJobStore,
} from "./indexingJobStore.js";

const DEFAULT_MAX_ATTEMPTS = 3;

function byCreatedOrder(a: IndexingJob, b: IndexingJob): number {
  return a.createdOrder - b.createdOrder || a.jobId.localeCompare(b.jobId);
}

function matchesFilters(job: IndexingJob, filters?: IndexingJobListFilters): boolean {
  if (!filters) return true;
  if (filters.status !== undefined && job.status !== filters.status) return false;
  if (filters.repositoryId !== undefined && job.repositoryId !== filters.repositoryId) return false;
  if (filters.ownerUserId !== undefined && job.ownerUserId !== filters.ownerUserId) return false;
  return true;
}

const DEFAULT_LEASE_DURATION_MS = 300_000;

export class MemoryIndexingJobStore implements SupervisedIndexingJobStore {
  private readonly jobs = new Map<string, IndexingJob>();
  private readonly now: () => Date;
  private nextSequence = 1;
  private nextOrder = 1;

  constructor(options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async createJob(input: CreateIndexingJobInput): Promise<IndexingJob> {
    const active = this.findActiveRepositoryJob(input.repositoryId);
    if (active) return cloneIndexingJob(active);

    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const createdOrder = this.nextOrder;
    this.nextOrder += 1;

    const job: IndexingJob = {
      jobId: `indexing-job-${sequence}`,
      repositoryId: input.repositoryId,
      ownerUserId: input.ownerUserId,
      repositoryOwner: input.repositoryOwner,
      repositoryName: input.repositoryName,
      repositoryUrl: input.repositoryUrl,
      branch: input.branch ?? null,
      status: "queued",
      sequence,
      attempt: 1,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      progress: 0,
      currentStage: "pending",
      failure: null,
      claimedBy: null,
      createdOrder,
      startedOrder: null,
      completedOrder: null,
      ...(input.createdByRequestId
        ? { createdByRequestId: input.createdByRequestId }
        : {}),
      ...(input.createdByTraceparent
        ? { createdByTraceparent: input.createdByTraceparent }
        : {}),
    };

    this.jobs.set(job.jobId, cloneIndexingJob(job));
    return cloneIndexingJob(job);
  }

  async getJob(jobId: string): Promise<IndexingJob | null> {
    const job = this.jobs.get(jobId);
    return job ? cloneIndexingJob(job) : null;
  }

  async listJobs(filters?: IndexingJobListFilters): Promise<IndexingJob[]> {
    return [...this.jobs.values()]
      .filter((job) => matchesFilters(job, filters))
      .sort(byCreatedOrder)
      .map(cloneIndexingJob);
  }

  async listRepositoryJobs(repositoryId: string): Promise<IndexingJob[]> {
    return this.listJobs({ repositoryId });
  }

  async getLatestRepositoryJob(repositoryId: string): Promise<IndexingJob | null> {
    const jobs = await this.listRepositoryJobs(repositoryId);
    return jobs.at(-1) ?? null;
  }

  async claimNextJob(
    workerId: string,
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  ): Promise<IndexingJob | null> {
    const now = this.now();
    const next = [...this.jobs.values()]
      .filter((job) =>
        job.status === "queued" &&
        (!job.nextRetryAt || Date.parse(job.nextRetryAt) <= now.getTime())
      )
      .sort(byCreatedOrder)[0];
    if (!next) return null;

    const transitioned = transitionIndexingJob(next, "claimed", {
      workerId,
      order: this.allocateOrder(),
    });
    if (!transitioned.ok) return null;

    const claimed = {
      ...transitioned.job,
      claimedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
      nextRetryAt: null,
    };
    this.jobs.set(next.jobId, cloneIndexingJob(claimed));
    return cloneIndexingJob(claimed);
  }

  async heartbeatJob(
    jobId: string,
    workerId: string,
    leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
  ): Promise<boolean> {
    const job = this.jobs.get(jobId);
    const now = this.now();
    if (
      !job ||
      !["claimed", "running"].includes(job.status) ||
      job.claimedBy !== workerId ||
      (job.leaseExpiresAt !== undefined && job.leaseExpiresAt !== null &&
        Date.parse(job.leaseExpiresAt) <= now.getTime())
    ) return false;
    this.jobs.set(jobId, cloneIndexingJob({
      ...job,
      heartbeatAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
    }));
    return true;
  }

  async scheduleRetry(
    jobId: string,
    workerId: string,
    failure: IndexingJobFailure,
    delayMs: number,
  ): Promise<IndexingJob | null> {
    const job = this.jobs.get(jobId);
    if (
      !job || job.status !== "failed" || job.claimedBy !== workerId ||
      !failure.retryable || job.failure?.retryable !== true ||
      job.attempt >= job.maxAttempts
    ) return null;
    const transitioned = transitionIndexingJob(job, "queued");
    if (!transitioned.ok) return null;
    const queued = {
      ...transitioned.job,
      claimedAt: null,
      startedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      nextRetryAt: new Date(this.now().getTime() + delayMs).toISOString(),
    };
    this.jobs.set(jobId, cloneIndexingJob(queued));
    return cloneIndexingJob(queued);
  }

  async recoverStaleJobs(input: StaleIndexingJobRecoveryInput): Promise<IndexingJob[]> {
    const leaseCutoff = Date.parse(input.leaseExpiresBefore ?? input.staleBefore);
    const heartbeatCutoff = Date.parse(input.staleBefore);
    const recovered: IndexingJob[] = [];
    for (const job of [...this.jobs.values()].sort(byCreatedOrder)) {
      if (!["claimed", "running"].includes(job.status)) continue;
      const leaseExpired = job.leaseExpiresAt
        ? Date.parse(job.leaseExpiresAt) <= leaseCutoff
        : Date.parse(job.heartbeatAt ?? job.claimedAt ?? "") <= heartbeatCutoff;
      if (!leaseExpired) continue;
      const retryable = job.attempt < job.maxAttempts;
      const failure: IndexingJobFailure = {
        code: "abandoned_lease",
        message: "Indexing worker lease expired before completion.",
        retryable,
      };
      const failed = transitionIndexingJob(job, "failed", {
        failure,
        order: this.allocateOrder(),
      });
      if (!failed.ok) continue;
      let result: IndexingJob = {
        ...failed.job,
        recoveryCount: (job.recoveryCount ?? 0) + 1,
        leaseExpiresAt: null,
      };
      if (retryable) {
        const queued = transitionIndexingJob(result, "queued");
        if (!queued.ok) continue;
        result = {
          ...queued.job,
          claimedAt: null,
          startedAt: null,
          heartbeatAt: null,
          leaseExpiresAt: null,
          nextRetryAt: new Date(this.now().getTime() + input.retryDelayMs).toISOString(),
          recoveryCount: result.recoveryCount,
        };
      }
      this.jobs.set(job.jobId, cloneIndexingJob(result));
      recovered.push(cloneIndexingJob(result));
    }
    return recovered;
  }

  async updateJob(jobId: string, patch: IndexingJobPatch): Promise<IndexingJob | null> {
    const existing = this.jobs.get(jobId);
    if (!existing) return null;

    const progress = patch.progress ?? existing.progress;
    const progressError = validateIndexingJobProgress(existing, progress);
    if (progressError) return null;

    const updated: IndexingJob = {
      ...existing,
      progress,
      currentStage: patch.currentStage ?? existing.currentStage,
      failure:
        patch.failure === undefined
          ? existing.failure
          : patch.failure
            ? { ...patch.failure }
            : null,
      maxAttempts: patch.maxAttempts ?? existing.maxAttempts,
    };

    this.jobs.set(jobId, cloneIndexingJob(updated));
    return cloneIndexingJob(updated);
  }

  async markRunning(
    jobId: string,
    stage: IndexingJobStage = "clone",
    workerId?: string,
  ): Promise<IndexingJob | null> {
    const existing = this.jobs.get(jobId);
    if (!existing || (workerId && existing.claimedBy !== workerId)) return null;

    const transitioned = transitionIndexingJob(existing, "running", { stage });
    if (!transitioned.ok) return null;

    this.jobs.set(jobId, cloneIndexingJob(transitioned.job));
    return cloneIndexingJob(transitioned.job);
  }

  async updateProgress(
    jobId: string,
    progress: number,
    stage?: IndexingJobStage,
    workerId?: string,
  ): Promise<IndexingJob | null> {
    const existing = this.jobs.get(jobId);
    if (workerId && existing?.claimedBy !== workerId) return null;
    return this.updateJob(jobId, {
      progress,
      currentStage: stage,
    });
  }

  async markSucceeded(jobId: string, workerId?: string): Promise<IndexingJob | null> {
    const existing = this.jobs.get(jobId);
    if (!existing || (workerId && existing.claimedBy !== workerId)) return null;
    if (existing.status === "succeeded") return cloneIndexingJob(existing);

    const transitioned = transitionIndexingJob(existing, "succeeded", {
      stage: "complete",
      order: this.allocateOrder(),
    });
    if (!transitioned.ok) return null;

    const succeeded = { ...transitioned.job, leaseExpiresAt: null };
    this.jobs.set(jobId, cloneIndexingJob(succeeded));
    return cloneIndexingJob(succeeded);
  }

  async markFailed(
    jobId: string,
    failure: IndexingJobFailure,
    workerId?: string,
  ): Promise<IndexingJob | null> {
    const existing = this.jobs.get(jobId);
    if (!existing || (workerId && existing.claimedBy !== workerId)) return null;

    const transitioned = transitionIndexingJob(existing, "failed", {
      failure,
      order: this.allocateOrder(),
    });
    if (!transitioned.ok) return null;

    const failed = { ...transitioned.job, leaseExpiresAt: null };
    this.jobs.set(jobId, cloneIndexingJob(failed));
    return cloneIndexingJob(failed);
  }

  async cancelJob(jobId: string): Promise<IndexingJob | null> {
    const existing = this.jobs.get(jobId);
    if (!existing) return null;

    const transitioned = transitionIndexingJob(existing, "cancelled", {
      order: this.allocateOrder(),
    });
    if (!transitioned.ok) return null;

    this.jobs.set(jobId, cloneIndexingJob(transitioned.job));
    return cloneIndexingJob(transitioned.job);
  }

  async deleteJob(jobId: string): Promise<boolean> {
    return this.jobs.delete(jobId);
  }

  async clear(): Promise<void> {
    this.jobs.clear();
    this.nextSequence = 1;
    this.nextOrder = 1;
  }

  private findActiveRepositoryJob(repositoryId: string): IndexingJob | null {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.repositoryId === repositoryId &&
          isActiveIndexingJobStatus(job.status),
      )
      .sort(byCreatedOrder)[0] ?? null;
  }

  private allocateOrder(): number {
    const order = this.nextOrder;
    this.nextOrder += 1;
    return order;
  }
}

export const indexingJobStore: IndexingJobStore = new MemoryIndexingJobStore();
