import { env } from "../../../config/env.js";
import type { IndexingJobStore } from "../../indexing/jobs/indexingJobStore.js";
import type { RepositoryStore } from "../store/repositoryStore.js";
import {
  RepositoryConnectionIdempotencyConflictError,
  throwIfConnectionAborted,
  type ConnectRepositoryTransactionInput,
  type RepositoryConnectionStore,
  type RepositoryConnectionTransactionResult,
} from "./repositoryConnectionStore.js";

interface IdempotencyRecord {
  payloadHash: string;
  result: RepositoryConnectionTransactionResult;
  expiresAt: number;
}

export class MemoryRepositoryConnectionStore implements RepositoryConnectionStore {
  private readonly records = new Map<string, IdempotencyRecord>();
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly repositories: RepositoryStore,
    private readonly jobs: IndexingJobStore,
    private readonly options: { retentionMs?: number; now?: () => number } = {},
  ) {}

  async connect(input: ConnectRepositoryTransactionInput): Promise<RepositoryConnectionTransactionResult> {
    return this.exclusive(async () => {
      throwIfConnectionAborted(input.signal);
      await this.cleanupExpiredUnlocked();
      const recordKey = `${input.ownerUserId}:${input.idempotencyKey}`;
      const existingRecord = this.records.get(recordKey);
      if (existingRecord) {
        if (existingRecord.payloadHash !== input.payloadHash) {
          throw new RepositoryConnectionIdempotencyConflictError();
        }
        return structuredClone({ ...existingRecord.result, replayed: true });
      }

      const repositoryId = `${input.repositoryOwner}/${input.repositoryName}`;
      const previousRepository = await this.repositories.getRepository(repositoryId);
      const previousActiveJob = (await this.jobs.listRepositoryJobs(repositoryId)).find((job) =>
        job.status === "queued" || job.status === "claimed" || job.status === "running"
      ) ?? null;
      let jobIdToRollback: string | null = null;
      try {
        if (previousRepository?.ownerUserId && previousRepository.ownerUserId !== input.ownerUserId) {
          throw new Error("repository_owner_mismatch");
        }
        await this.repositories.connectRepository({
          owner: input.repositoryOwner,
          repo: input.repositoryName,
          ownerUserId: input.ownerUserId,
        });
        throwIfConnectionAborted(input.signal);
        const job = await this.jobs.createJob({
          repositoryId,
          ownerUserId: input.ownerUserId,
          repositoryOwner: input.repositoryOwner,
          repositoryName: input.repositoryName,
          repositoryUrl: input.repositoryUrl,
          branch: input.branch,
          createdByRequestId: input.requestId,
          ...(input.traceparent ? { createdByTraceparent: input.traceparent } : {}),
        });
        if (!previousActiveJob || previousActiveJob.jobId !== job.jobId) jobIdToRollback = job.jobId;
        throwIfConnectionAborted(input.signal);
        await this.repositories.markIndexing(repositoryId);
        throwIfConnectionAborted(input.signal);
        const result: RepositoryConnectionTransactionResult = {
          response: { repositoryId, jobId: job.jobId, status: "queued" },
          job,
          replayed: false,
        };
        this.records.set(recordKey, {
          payloadHash: input.payloadHash,
          result: structuredClone(result),
          expiresAt: this.now() + (this.options.retentionMs ?? env.REPOSITORY_CONNECTION_IDEMPOTENCY_RETENTION_MS),
        });
        return structuredClone(result);
      } catch (error) {
        if (jobIdToRollback) await this.jobs.deleteJob(jobIdToRollback);
        if (!previousRepository) {
          await this.repositories.deleteRepository(repositoryId);
        } else {
          const current = await this.repositories.getRepository(repositoryId);
          if (current && current.status !== previousRepository.status) {
            await this.repositories.updateRepository(repositoryId, {
              status: previousRepository.status,
              ownerUserId: previousRepository.ownerUserId,
            }, current.persistenceVersion);
          }
        }
        throw error;
      }
    });
  }

  async cleanupExpired(signal?: AbortSignal): Promise<number> {
    return this.exclusive(async () => {
      throwIfConnectionAborted(signal);
      return this.cleanupExpiredUnlocked();
    });
  }

  async verify(signal?: AbortSignal): Promise<void> {
    throwIfConnectionAborted(signal);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async cleanupExpiredUnlocked(): Promise<number> {
    let removed = 0;
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt > now) continue;
      this.records.delete(key);
      removed += 1;
    }
    return removed;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
