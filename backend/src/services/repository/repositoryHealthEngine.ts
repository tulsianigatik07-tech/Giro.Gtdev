import { buildRepositoryDashboardSummary } from "./repositoryDashboardSummary.js";
import type { RepositoryDashboardSummary } from "./repositoryDashboardSummary.js";
import {
  listRepositoryLifecycleEvents,
  type RepositoryLifecycleEvent,
} from "./repositoryLifecycleEvents.js";

export type RepositoryHealthGrade = "excellent" | "good" | "fair" | "poor";

export interface RepositoryHealthSignals {
  indexed: boolean;
  ready: boolean;
  stale: boolean;
  hasRecentLifecycleActivity: boolean;
  cleanupSignalsAvailable: boolean;
}

export interface RepositoryHealthEngineInput {
  dashboard: RepositoryDashboardSummary;
  events?: readonly RepositoryLifecycleEvent[];
}

export interface RepositoryHealthEngineResult {
  repositoryId: string;
  score: number;
  grade: RepositoryHealthGrade;
  healthy: boolean;
  signals: RepositoryHealthSignals;
  warnings: string[];
  recommendations: string[];
}

function grade(score: number): RepositoryHealthGrade {
  if (score >= 90) return "excellent";
  if (score >= 70) return "good";
  if (score >= 40) return "fair";
  return "poor";
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function hasCleanupSkipSignal(events: readonly RepositoryLifecycleEvent[]): boolean {
  return events.some((event) => {
    if (event.type !== "repository_cleanup_reported") return false;
    const totalSkipped = event.metadata.totalSkipped;
    return typeof totalSkipped === "number" && totalSkipped > 0;
  });
}

function hasCleanupFailure(events: readonly RepositoryLifecycleEvent[]): boolean {
  return events.some((event) => event.type === "repository_cleanup_failed");
}

export function buildRepositoryHealthEngineResult(
  input: RepositoryHealthEngineInput,
): RepositoryHealthEngineResult {
  const { dashboard } = input;
  const events = [...(input.events ?? [])];
  const status = dashboard.status.health;
  const readiness = dashboard.status.readiness;
  const signals: RepositoryHealthSignals = {
    indexed: status.indexed,
    ready: readiness.ready,
    stale: status.stale,
    hasRecentLifecycleActivity: events.length > 0,
    cleanupSignalsAvailable: events.some((event) =>
      event.type.startsWith("repository_cleanup_"),
    ),
  };

  let score = 10;
  if (signals.indexed) score += 40;
  if (signals.ready) score += 30;
  if (signals.hasRecentLifecycleActivity) score += 10;
  if (signals.cleanupSignalsAvailable) score += 5;
  if (dashboard.metrics.files > 0) score += 5;

  if (signals.stale) score -= 25;
  if (status.status === "missing") score -= 10;
  if (status.status === "failed") score -= 30;
  if (hasCleanupFailure(events)) score -= 20;
  if (hasCleanupSkipSignal(events)) score -= 5;

  score = clampScore(score);

  const warnings: string[] = [];
  const recommendations: string[] = [];

  if (!signals.indexed) {
    warnings.push("Repository is not indexed.");
    recommendations.push("Index the repository before relying on dashboard insights.");
  }

  if (!signals.ready) {
    warnings.push("Repository is not ready for retrieval.");
    recommendations.push("Complete repository indexing to make retrieval available.");
  }

  if (signals.stale) {
    warnings.push("Repository index is stale.");
    recommendations.push("Refresh or reindex the repository to restore freshness.");
  }

  if (hasCleanupSkipSignal(events)) {
    warnings.push("Cleanup skipped unsupported resources.");
    recommendations.push("Review cleanup warnings before reconnecting the repository.");
  }

  if (hasCleanupFailure(events)) {
    warnings.push("Repository cleanup failed.");
    recommendations.push("Retry cleanup after resolving the reported failure.");
  }

  if (!signals.hasRecentLifecycleActivity) {
    recommendations.push("Open the repository dashboard to record lifecycle activity.");
  }

  return {
    repositoryId: dashboard.repository,
    score,
    grade: grade(score),
    healthy: score >= 70 && signals.indexed && signals.ready && !signals.stale,
    signals,
    warnings: sortedUnique(warnings),
    recommendations: sortedUnique(recommendations),
  };
}

export function buildRepositoryHealthEngineResultForRepository(
  owner: string,
  repo: string,
): RepositoryHealthEngineResult {
  const repositoryId = `${owner}/${repo}`;
  return buildRepositoryHealthEngineResult({
    dashboard: buildRepositoryDashboardSummary(owner, repo),
    events: listRepositoryLifecycleEvents(repositoryId),
  });
}
