// Deterministic product-facing repository insights. Pure transformation over
// existing Giro signals only: no LLM, persistence, routes, I/O, timestamps,
// randomness, or hidden state. Inputs are never mutated.

import type { RepositoryActivityTimelineItem } from "./repositoryActivityTimeline.js";
import type { RepositoryDashboardSummary } from "./repositoryDashboardSummary.js";
import type { RepositoryHealthEngineResult } from "./repositoryHealthEngine.js";
import type { RetrievalExplainabilitySummary } from "../retrieval/retrievalExplainabilitySummary.js";

export type RepositoryInsightType =
  | "health"
  | "indexing"
  | "retrieval"
  | "cleanup"
  | "lifecycle"
  | "architecture";

export type RepositoryInsightSeverity =
  | "info"
  | "success"
  | "warning"
  | "critical";

export type RepositoryInsightSignalValue =
  | string
  | number
  | boolean
  | null;

export interface RepositoryInsight {
  id: string;
  type: RepositoryInsightType;
  severity: RepositoryInsightSeverity;
  title: string;
  description: string;
  recommendation?: string;
  signals: Record<string, RepositoryInsightSignalValue>;
}

export interface RepositoryInsightsSummary {
  total: number;
  critical: number;
  warnings: number;
  successes: number;
  informational: number;
}

export interface RepositoryInsightsEngineInput {
  repositoryId?: string;
  health?: RepositoryHealthEngineResult;
  dashboard?: RepositoryDashboardSummary;
  timeline?: readonly RepositoryActivityTimelineItem[];
  retrievalExplainability?: RetrievalExplainabilitySummary;
}

export interface RepositoryInsightsEngineResult {
  repositoryId: string;
  insights: RepositoryInsight[];
  summary: RepositoryInsightsSummary;
}

type SourceBreakdown = RetrievalExplainabilitySummary["sourceBreakdown"];
type SourceKey = keyof SourceBreakdown;

const SOURCE_ORDER: SourceKey[] = [
  "semantic",
  "keyword",
  "symbol",
  "graph",
  "fileSearch",
];

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "signal";
}

function addInsight(
  insights: RepositoryInsight[],
  insight: RepositoryInsight,
): void {
  if (!insights.some((item) => item.id === insight.id)) {
    insights.push(insight);
  }
}

function repositoryIdFor(input: RepositoryInsightsEngineInput): string {
  return (
    input.repositoryId ??
    input.health?.repositoryId ??
    input.dashboard?.repository ??
    input.timeline?.[0]?.repositoryId ??
    "unknown"
  );
}

function summarize(insights: readonly RepositoryInsight[]): RepositoryInsightsSummary {
  return {
    total: insights.length,
    critical: insights.filter((insight) => insight.severity === "critical").length,
    warnings: insights.filter((insight) => insight.severity === "warning").length,
    successes: insights.filter((insight) => insight.severity === "success").length,
    informational: insights.filter((insight) => insight.severity === "info").length,
  };
}

function dominantRetrievalSource(
  sourceBreakdown: SourceBreakdown,
): { source: SourceKey; count: number } | undefined {
  return SOURCE_ORDER
    .map((source) => ({ source, count: sourceBreakdown[source] }))
    .filter((entry) => entry.count > 0)
    .sort(
      (a, b) =>
        b.count - a.count ||
        SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source),
    )[0];
}

function numberMetadata(
  value: RepositoryActivityTimelineItem["metadata"][string] | undefined,
): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addHealthInsights(
  insights: RepositoryInsight[],
  health: RepositoryHealthEngineResult | undefined,
): void {
  if (!health) return;

  if (health.healthy) {
    addInsight(insights, {
      id: "health.ready",
      type: "health",
      severity: "success",
      title: "Repository is healthy",
      description: "Repository is indexed, ready, and not stale.",
      signals: {
        score: health.score,
        grade: health.grade,
        indexed: health.signals.indexed,
        ready: health.signals.ready,
      },
    });
  } else if (health.score < 40) {
    addInsight(insights, {
      id: "health.critical",
      type: "health",
      severity: "critical",
      title: "Repository health is poor",
      description: "Repository health is below the safe operating threshold.",
      recommendation: health.recommendations[0] ?? "Review repository health signals.",
      signals: {
        score: health.score,
        grade: health.grade,
        healthy: health.healthy,
      },
    });
  } else if (health.score < 70) {
    addInsight(insights, {
      id: "health.warning",
      type: "health",
      severity: "warning",
      title: "Repository health needs attention",
      description: "Repository health is below the healthy threshold.",
      recommendation: health.recommendations[0] ?? "Review repository health signals.",
      signals: {
        score: health.score,
        grade: health.grade,
        healthy: health.healthy,
      },
    });
  }

  for (const warning of health.warnings) {
    addInsight(insights, {
      id: `health.warning.${slug(warning)}`,
      type: "health",
      severity: "warning",
      title: "Health warning",
      description: warning,
      recommendation:
        health.recommendations.find((item) => item.length > 0) ??
        "Review repository health details.",
      signals: {
        score: health.score,
        grade: health.grade,
      },
    });
  }
}

function addIndexingInsights(
  insights: RepositoryInsight[],
  dashboard: RepositoryDashboardSummary | undefined,
): void {
  if (!dashboard) return;

  const health = dashboard.status.health;
  const readiness = dashboard.status.readiness;

  if (health.status === "missing") {
    addInsight(insights, {
      id: "indexing.missing",
      type: "indexing",
      severity: "critical",
      title: "Repository metadata is missing",
      description: "Repository dashboard metadata is not available.",
      recommendation: "Index the repository before relying on insights.",
      signals: {
        status: health.status,
        files: dashboard.metrics.files,
        chunks: dashboard.metrics.chunks,
      },
    });
    return;
  }

  if (health.stale) {
    addInsight(insights, {
      id: "indexing.stale",
      type: "indexing",
      severity: "warning",
      title: "Repository index is stale",
      description: "Repository should be refreshed before retrieval is trusted.",
      recommendation: "Refresh or reindex the repository.",
      signals: {
        status: health.status,
        stale: health.stale,
      },
    });
    return;
  }

  if (health.indexed && readiness.ready) {
    addInsight(insights, {
      id: "indexing.ready",
      type: "indexing",
      severity: "success",
      title: "Repository is indexed and ready",
      description: "Repository is indexed and ready for retrieval.",
      signals: {
        files: dashboard.metrics.files,
        chunks: dashboard.metrics.chunks,
        symbols: dashboard.metrics.symbols,
      },
    });
  }
}

function addRetrievalInsights(
  insights: RepositoryInsight[],
  retrieval: RetrievalExplainabilitySummary | undefined,
): void {
  if (!retrieval) return;

  if (retrieval.totalResults === 0) {
    addInsight(insights, {
      id: "retrieval.no-results",
      type: "retrieval",
      severity: "warning",
      title: "Retrieval returned no results",
      description: "No retrieval context was selected for this repository signal set.",
      recommendation: "Index more repository content or broaden the retrieval query.",
      signals: {
        totalResults: retrieval.totalResults,
      },
    });
    return;
  }

  const dominant = dominantRetrievalSource(retrieval.sourceBreakdown);
  if (dominant?.source === "semantic") {
    addInsight(insights, {
      id: "retrieval.semantic-dominant",
      type: "retrieval",
      severity: "info",
      title: "Retrieval is dominated by semantic matches",
      description: "Semantic retrieval contributes the largest share of selected context.",
      signals: {
        source: dominant.source,
        count: dominant.count,
        totalResults: retrieval.totalResults,
      },
    });
  }

  if (retrieval.topFiles.length > 1) {
    addInsight(insights, {
      id: "retrieval.multi-file-grounding",
      type: "retrieval",
      severity: "success",
      title: "Retrieval uses multiple files",
      description: "Multiple files contribute to context, which improves answer grounding.",
      signals: {
        fileCount: retrieval.topFiles.length,
        totalResults: retrieval.totalResults,
      },
    });
  } else if (retrieval.topFiles.length === 1) {
    addInsight(insights, {
      id: "retrieval.single-file-concentration",
      type: "retrieval",
      severity: "info",
      title: "Retrieval is concentrated in one file",
      description: "Selected context is concentrated in a single file.",
      recommendation: "Check whether additional files should contribute to context.",
      signals: {
        filePath: retrieval.topFiles[0]!.filePath,
        resultCount: retrieval.topFiles[0]!.resultCount,
      },
    });
  }
}

function addCleanupInsights(
  insights: RepositoryInsight[],
  timeline: readonly RepositoryActivityTimelineItem[] | undefined,
): void {
  if (!timeline) return;

  const cleanupFailed = timeline.find((item) => item.type === "repository_cleanup_failed");
  if (cleanupFailed) {
    addInsight(insights, {
      id: "cleanup.failed",
      type: "cleanup",
      severity: "critical",
      title: "Repository cleanup failed",
      description: cleanupFailed.message,
      recommendation: "Retry cleanup after resolving the reported failure.",
      signals: {
        sequence: cleanupFailed.sequence,
      },
    });
    return;
  }

  const cleanupReported = [...timeline]
    .filter((item) => item.type === "repository_cleanup_reported")
    .sort((a, b) => a.sequence - b.sequence)[0];

  if (!cleanupReported) return;

  const totalSkipped = numberMetadata(cleanupReported.metadata.totalSkipped);
  const totalExecuted = numberMetadata(cleanupReported.metadata.totalExecuted);

  if (totalSkipped > 0) {
    addInsight(insights, {
      id: "cleanup.skipped-resources",
      type: "cleanup",
      severity: "warning",
      title: "Cleanup skipped unsupported resources",
      description: "Cleanup completed with unsupported resources skipped.",
      recommendation: "Review cleanup warnings before reconnecting the repository.",
      signals: {
        totalExecuted,
        totalSkipped,
      },
    });
    return;
  }

  addInsight(insights, {
    id: "cleanup.completed",
    type: "cleanup",
    severity: "success",
    title: "Cleanup completed",
    description: "Repository cleanup completed without skipped resources.",
    signals: {
      totalExecuted,
      totalSkipped,
    },
  });
}

function addLifecycleInsights(
  insights: RepositoryInsight[],
  timeline: readonly RepositoryActivityTimelineItem[] | undefined,
  health: RepositoryHealthEngineResult | undefined,
): void {
  if (!timeline || timeline.length === 0) {
    addInsight(insights, {
      id: "lifecycle.no-activity",
      type: "lifecycle",
      severity: health?.healthy === false ? "warning" : "info",
      title: "No lifecycle activity recorded",
      description: "No deterministic lifecycle events are available for this repository.",
      recommendation: "Open the repository dashboard or run a lifecycle operation.",
      signals: {
        eventCount: 0,
      },
    });
    return;
  }

  addInsight(insights, {
    id: "lifecycle.activity-recorded",
    type: "lifecycle",
    severity: "info",
    title: "Lifecycle activity is available",
    description: "Repository lifecycle events can support activity timelines and audit views.",
    signals: {
      eventCount: timeline.length,
      latestSequence: Math.max(...timeline.map((item) => item.sequence)),
    },
  });
}

function addArchitectureInsights(
  insights: RepositoryInsight[],
  dashboard: RepositoryDashboardSummary | undefined,
): void {
  if (!dashboard || dashboard.metrics.graphNodes === 0) return;

  addInsight(insights, {
    id: "architecture.graph-signals-available",
    type: "architecture",
    severity: "info",
    title: "Architecture graph signals are available",
    description: "Repository graph metrics can support architecture-aware insights.",
    signals: {
      graphNodes: dashboard.metrics.graphNodes,
      graphEdges: dashboard.metrics.graphEdges,
    },
  });
}

export function buildRepositoryInsightsEngineResult(
  input: RepositoryInsightsEngineInput,
): RepositoryInsightsEngineResult {
  const insights: RepositoryInsight[] = [];
  const repositoryId = repositoryIdFor(input);

  if (
    !input.health &&
    !input.dashboard &&
    !input.retrievalExplainability &&
    (!input.timeline || input.timeline.length === 0)
  ) {
    addInsight(insights, {
      id: "baseline.no-signals",
      type: "lifecycle",
      severity: "info",
      title: "Repository signals are unavailable",
      description: "No deterministic repository signals were provided to the insights engine.",
      recommendation: "Index the repository and collect dashboard signals.",
      signals: {
        signalCount: 0,
      },
    });
  }

  addHealthInsights(insights, input.health);
  addIndexingInsights(insights, input.dashboard);
  addRetrievalInsights(insights, input.retrievalExplainability);
  addCleanupInsights(insights, input.timeline);
  addLifecycleInsights(insights, input.timeline, input.health);
  addArchitectureInsights(insights, input.dashboard);

  return {
    repositoryId,
    insights,
    summary: summarize(insights),
  };
}
