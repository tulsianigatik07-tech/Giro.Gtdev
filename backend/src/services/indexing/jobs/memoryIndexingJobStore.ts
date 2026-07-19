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

export class MemoryIndexingJobStore implements IndexingJobStore {
  private readonly jobs = new Map<string, IndexingJob>();
  private nextSequence = 1;
  private nextOrder = 1;

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

  async claimNextJob(workerId: string): Promise<IndexingJob | null> {
    const next = [...this.jobs.values()]
      .filter((job) => job.status === "queued")
      .sort(byCreatedOrder)[0];
    if (!next) return null;

    const transitioned = transitionIndexingJob(next, "claimed", {
      workerId,
      order: this.allocateOrder(),
    });
    if (!transitioned.ok) return null;

    this.jobs.set(next.jobId, cloneIndexingJob(transitioned.job));
    return cloneIndexingJob(transitioned.job);
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

  async markRunning(jobId: string, stage: IndexingJobStage = "clone"): Promise<IndexingJob | null> {
    const existing = this.jobs.get(jobId);
    if (!existing) return null;

    const transitioned = transitionIndexingJob(existing, "running", { stage });
    if (!transitioned.ok) return null;

    this.jobs.set(jobId, cloneIndexingJob(transitioned.job));
    return cloneIndexingJob(transitioned.job);
  }

  async updateProgress(
    jobId: string,
    progress: number,
    stage?: IndexingJobStage,
  ): Promise<IndexingJob | null> {
    return this.updateJob(jobId, {
      progress,
      currentStage: stage,
    });
  }

  async markSucceeded(jobId: string): Promise<IndexingJob | null> {
    const existing = this.jobs.get(jobId);
    if (!existing) return null;
    if (existing.status === "succeeded") return cloneIndexingJob(existing);

    const transitioned = transitionIndexingJob(existing, "succeeded", {
      stage: "complete",
      order: this.allocateOrder(),
    });
    if (!transitioned.ok) return null;

    this.jobs.set(jobId, cloneIndexingJob(transitioned.job));
    return cloneIndexingJob(transitioned.job);
  }

  async markFailed(
    jobId: string,
    failure: IndexingJobFailure,
  ): Promise<IndexingJob | null> {
    const existing = this.jobs.get(jobId);
    if (!existing) return null;

    const transitioned = transitionIndexingJob(existing, "failed", {
      failure,
      order: this.allocateOrder(),
    });
    if (!transitioned.ok) return null;

    this.jobs.set(jobId, cloneIndexingJob(transitioned.job));
    return cloneIndexingJob(transitioned.job);
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
