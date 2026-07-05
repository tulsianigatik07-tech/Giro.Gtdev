// Deterministic repository recommendation engine. Pure action layer over
// existing repository signals: no LLM, routes, persistence, async work, I/O,
// timestamps, randomness, global state, or mutation.

import type { RepositoryActivityTimelineItem } from "./repositoryActivityTimeline.js";
import type { RepositoryAiReadinessResult } from "./repositoryAiReadinessEngine.js";
import type { RepositoryDashboardSummary } from "./repositoryDashboardSummary.js";
import type { RepositoryHealthEngineResult } from "./repositoryHealthEngine.js";
import type {
  RepositoryInsight,
  RepositoryInsightsEngineResult,
} from "./repositoryInsightsEngine.js";

export type RepositoryRecommendationPriority =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info";

export type RepositoryRecommendationSeverity =
  | "critical"
  | "warning"
  | "info";

export type RepositoryRecommendationCategory =
  | "indexing"
  | "readiness"
  | "cleanup"
  | "health"
  | "insights"
  | "lifecycle";

export interface RepositoryRecommendation {
  id: string;
  priority: RepositoryRecommendationPriority;
  severity: RepositoryRecommendationSeverity;
  title: string;
  description: string;
  reason: string;
  category: RepositoryRecommendationCategory;
  action: string;
}

export interface RepositoryRecommendationSummary {
  total: number;
  critical: number;
  warnings: number;
  informational: number;
}

export interface RepositoryRecommendationInput {
  dashboard: RepositoryDashboardSummary;
  health: RepositoryHealthEngineResult;
  aiReadiness: RepositoryAiReadinessResult;
  insights: RepositoryInsightsEngineResult;
  timeline: readonly RepositoryActivityTimelineItem[];
}

export interface RepositoryRecommendationResult {
  repositoryId: string;
  recommendations: RepositoryRecommendation[];
  summary: RepositoryRecommendationSummary;
}

const PRIORITY_ORDER: RepositoryRecommendationPriority[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

function priorityRank(priority: RepositoryRecommendationPriority): number {
  return PRIORITY_ORDER.indexOf(priority);
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || "signal";
}

function addRecommendation(
  recommendations: RepositoryRecommendation[],
  recommendation: RepositoryRecommendation,
): void {
  if (!recommendations.some((item) => item.id === recommendation.id)) {
    recommendations.push(recommendation);
  }
}

function cleanupHasExecuted(
  timeline: readonly RepositoryActivityTimelineItem[],
): boolean {
  return timeline.some(
    (item) =>
      item.type === "repository_cleanup_executed" ||
      item.type === "repository_cleanup_reported",
  );
}

function promoteInsight(insight: RepositoryInsight): RepositoryRecommendation {
  const priority: RepositoryRecommendationPriority =
    insight.severity === "critical" ? "critical" : "high";

  return {
    id: `insight.${insight.id}`,
    priority,
    severity: insight.severity === "critical" ? "critical" : "warning",
    title: insight.title,
    description: insight.description,
    reason: `Insight ${insight.id} has ${insight.severity} severity.`,
    category: "insights",
    action: insight.recommendation ?? "Review the repository insight.",
  };
}

function summarize(
  recommendations: readonly RepositoryRecommendation[],
): RepositoryRecommendationSummary {
  return {
    total: recommendations.length,
    critical: recommendations.filter((item) => item.severity === "critical").length,
    warnings: recommendations.filter((item) => item.severity === "warning").length,
    informational: recommendations.filter((item) => item.severity === "info").length,
  };
}

function sortRecommendations(
  recommendations: readonly RepositoryRecommendation[],
): RepositoryRecommendation[] {
  return [...recommendations].sort(
    (a, b) =>
      priorityRank(a.priority) - priorityRank(b.priority) ||
      a.id.localeCompare(b.id),
  );
}

export function buildRepositoryRecommendations(
  input: RepositoryRecommendationInput,
): RepositoryRecommendationResult {
  const recommendations: RepositoryRecommendation[] = [];
  const repositoryId = input.dashboard.repository;

  if (!input.health.signals.indexed || input.dashboard.status.health.status === "missing") {
    addRecommendation(recommendations, {
      id: "indexing.run-indexing",
      priority: "critical",
      severity: "critical",
      title: "Index the repository",
      description: "Repository is not indexed, so Giro cannot provide complete intelligence.",
      reason: "Health signals report that repository indexing is not complete.",
      category: "indexing",
      action: "Run indexing.",
    });
  }

  if (input.health.signals.stale || input.dashboard.status.health.stale) {
    addRecommendation(recommendations, {
      id: "indexing.reindex-stale",
      priority: "high",
      severity: "warning",
      title: "Re-index stale repository",
      description: "Repository index is stale and may not reflect current code.",
      reason: "Health signals report stale repository metadata.",
      category: "indexing",
      action: "Re-index the repository.",
    });
  }

  if (input.aiReadiness.level === "blocked") {
    addRecommendation(recommendations, {
      id: "readiness.resolve-blockers",
      priority: "critical",
      severity: "critical",
      title: "Resolve AI readiness blockers",
      description: "Repository is blocked from AI-assisted interaction.",
      reason: input.aiReadiness.blockers.join(" ") || "AI readiness level is blocked.",
      category: "readiness",
      action: "Resolve readiness blockers.",
    });
  } else if (input.aiReadiness.level === "degraded") {
    addRecommendation(recommendations, {
      id: "readiness.improve-degraded",
      priority: "medium",
      severity: "warning",
      title: "Improve AI readiness",
      description: "Repository is available for AI assistance with degraded confidence.",
      reason: input.aiReadiness.warnings.join(" ") || "AI readiness level is degraded.",
      category: "readiness",
      action: "Improve readiness before relying on AI answers.",
    });
  }

  if (!cleanupHasExecuted(input.timeline)) {
    addRecommendation(recommendations, {
      id: "cleanup.run-cleanup",
      priority: "low",
      severity: "info",
      title: "Run repository cleanup",
      description: "No cleanup execution has been recorded for this repository.",
      reason: "Timeline does not contain a repository cleanup execution or report event.",
      category: "cleanup",
      action: "Run cleanup when repository lifecycle metadata should be reset.",
    });
  }

  for (const warning of input.health.warnings) {
    addRecommendation(recommendations, {
      id: `health.warning.${slug(warning)}`,
      priority: "high",
      severity: "warning",
      title: "Address health warning",
      description: warning,
      reason: "Repository health engine reported this warning.",
      category: "health",
      action:
        input.health.recommendations[0] ??
        "Review repository health and apply the recommended fix.",
    });
  }

  for (const insight of input.insights.insights) {
    if (insight.severity === "critical" || insight.severity === "warning") {
      addRecommendation(recommendations, promoteInsight(insight));
    }
  }

  if (recommendations.length === 0) {
    addRecommendation(recommendations, {
      id: "repository.healthy",
      priority: "info",
      severity: "info",
      title: "Repository is healthy",
      description: "Repository signals do not require action.",
      reason: "Health, readiness, insights, and lifecycle signals are in a healthy state.",
      category: "lifecycle",
      action: "Maintain current repository lifecycle practices.",
    });
  }

  const sorted = sortRecommendations(recommendations);

  return {
    repositoryId,
    recommendations: sorted,
    summary: summarize(sorted),
  };
}
