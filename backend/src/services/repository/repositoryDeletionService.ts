import { logger, type StructuredLogger } from "../../lib/logger.js";
import type { IndexingJobStore } from "../indexing/jobs/indexingJobStore.js";
import { runtimeIndexingJobStore } from "../indexing/jobs/runtimeIndexingJobStore.js";
import { removeRepositoryCheckout } from "../security/repositoryPaths.js";
import type { RepositoryCleanupReport } from "./repositoryCleanupReport.js";
import type { RepositoryDeletionTombstone, RepositoryStore } from "./store/repositoryStore.js";
import { repositoryStore as runtimeRepositoryStore } from "./store/runtimeRepositoryStore.js";

export interface RepositoryDeletionResult {
  tombstone: RepositoryDeletionTombstone;
  report: RepositoryCleanupReport;
  repeated: boolean;
}

export class RepositoryDeletionService {
  constructor(private readonly dependencies: {
    repositoryStore: RepositoryStore;
    indexingJobStore: IndexingJobStore;
    removeCheckout?: typeof removeRepositoryCheckout;
    logger?: Pick<StructuredLogger, "info" | "warn" | "error">;
  }) {}

  async tombstone(repositoryId: string): Promise<RepositoryDeletionTombstone | null> {
    return this.dependencies.repositoryStore.getDeletionTombstone?.(repositoryId) ?? null;
  }

  async delete(input: {
    repositoryId: string;
    ownerUserId: string;
    expectedVersion: number;
    report: RepositoryCleanupReport;
  }): Promise<RepositoryDeletionResult> {
    const existing = await this.tombstone(input.repositoryId);
    if (existing) {
      if (existing.ownerUserId !== input.ownerUserId) throw new Error("repository_not_owned");
      const tombstone = existing.cleanupPending ? await this.cleanup(existing) : existing;
      return { tombstone, report: tombstone.responseReport as RepositoryCleanupReport, repeated: true };
    }
    if (!this.dependencies.repositoryStore.deleteRepositoryDurably) {
      throw new Error("Transactional repository deletion is unavailable.");
    }
    const tombstone = await this.dependencies.repositoryStore.deleteRepositoryDurably({
      repositoryId: input.repositoryId,
      ownerUserId: input.ownerUserId,
      expectedVersion: input.expectedVersion,
      responseReport: input.report,
    });
    // The durable Supabase transaction fences/deletes jobs itself. This hook
    // supplies the same terminal behavior for the in-memory adapter.
    await this.dependencies.indexingJobStore.fenceAndDeleteRepositoryJobs?.(input.repositoryId);
    return { tombstone: await this.cleanup(tombstone), report: input.report, repeated: false };
  }

  async recoverPendingFilesystemCleanup(): Promise<number> {
    const pending = await this.dependencies.repositoryStore.listPendingDeletionCleanups?.() ?? [];
    let completed = 0;
    for (const tombstone of pending) {
      const recovered = await this.cleanup(tombstone);
      if (!recovered.cleanupPending) completed += 1;
    }
    return completed;
  }

  private async cleanup(tombstone: RepositoryDeletionTombstone): Promise<RepositoryDeletionTombstone> {
    const log = this.dependencies.logger ?? logger;
    try {
      await (this.dependencies.removeCheckout ?? removeRepositoryCheckout)(tombstone.repositoryId);
      let updated: RepositoryDeletionTombstone | null | undefined;
      try {
        updated = await this.dependencies.repositoryStore.recordDeletionCleanupResult?.({
          repositoryId: tombstone.repositoryId,
          succeeded: true,
        });
      } catch {
        log.error("repository_deletion_cleanup_status_persist_failed", { repositoryId: tombstone.repositoryId });
      }
      log.info("repository_deletion_filesystem_cleanup_completed", {
        repositoryId: tombstone.repositoryId,
      });
      return updated ?? { ...tombstone, cleanupPending: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "filesystem cleanup failed";
      let updated: RepositoryDeletionTombstone | null | undefined;
      try {
        updated = await this.dependencies.repositoryStore.recordDeletionCleanupResult?.({
          repositoryId: tombstone.repositoryId,
          succeeded: false,
          error: message,
        });
      } catch {
        log.error("repository_deletion_cleanup_status_persist_failed", { repositoryId: tombstone.repositoryId });
      }
      log.warn("repository_deletion_filesystem_cleanup_pending", {
        repositoryId: tombstone.repositoryId,
        reasonCode: "filesystem_cleanup_failed",
      });
      return updated ?? { ...tombstone, cleanupPending: true, cleanupLastError: message };
    }
  }
}

export const runtimeRepositoryDeletionService = new RepositoryDeletionService({
  repositoryStore: runtimeRepositoryStore,
  indexingJobStore: runtimeIndexingJobStore,
  logger,
});
