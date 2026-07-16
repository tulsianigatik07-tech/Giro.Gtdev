import { logger as runtimeLogger } from "../../lib/logger.js";
import { runtimeMetrics } from "../../observability/metrics.js";
import type {
  RepositorySummary,
  RepositorySummaryLogger,
  RepositorySummaryMetrics,
} from "./summaryTypes.js";

const store = new Map<string, RepositorySummary>();

function clone(summary: RepositorySummary): RepositorySummary {
  return structuredClone(summary);
}

export function saveRepositorySummary(summary: RepositorySummary): void {
  const existing = store.get(summary.repositoryId);
  if (existing && existing.repositoryVersion !== summary.repositoryVersion) {
    runtimeLogger.info("repository_summary_invalidated", {
      repositoryId: summary.repositoryId,
      previousVersion: existing.repositoryVersion,
      repositoryVersion: summary.repositoryVersion,
    });
  }
  store.set(summary.repositoryId, clone(summary));
}

export function getRepositorySummary(
  repositoryId: string,
  options: {
    repositoryVersion?: string;
    metrics?: RepositorySummaryMetrics;
    logger?: RepositorySummaryLogger;
  } = {},
): RepositorySummary | null {
  const summary = store.get(repositoryId);
  if (!summary) return null;
  if (options.repositoryVersion && summary.repositoryVersion !== options.repositoryVersion) {
    return null;
  }
  const metrics = options.metrics ?? runtimeMetrics;
  const summaryLogger = options.logger ?? runtimeLogger;
  metrics.incrementRepositorySummaryCacheHit();
  summaryLogger.info("repository_summary_cached", {
    repositoryId,
    repositoryVersion: summary.repositoryVersion,
  });
  return clone(summary);
}

export function removeRepositorySummary(repositoryId: string): void {
  store.delete(repositoryId);
}

export function clearRepositorySummaries(): void {
  store.clear();
}
