// Frontend presentation layer for the canonical repository intelligence report.
// Pure view-model mapping only: no service reads, state recomputation, async,
// persistence, I/O, timestamps, randomness, hidden state, or mutation.

import type {
  RepositoryIntelligenceReport,
  RepositoryIntelligenceReportStatus,
} from "./repositoryIntelligenceReport.js";
import type {
  RepositoryRecommendationPriority,
  RepositoryRecommendationSeverity,
} from "./repositoryRecommendationEngine.js";
import type { RepositoryActivityTimelineItem } from "./repositoryActivityTimeline.js";

export type RepositoryPresentationTone =
  | "success"
  | "warning"
  | "critical"
  | "info";

export interface RepositoryIntelligenceHeroCard {
  title: string;
  subtitle: string;
  status: RepositoryIntelligenceReportStatus;
  score: number;
  badge: string;
}

export interface RepositoryIntelligenceOverviewCard {
  title: string;
  value: string | number | boolean;
  tone: RepositoryPresentationTone;
}

export interface RepositoryIntelligenceRecommendationCard {
  priority: RepositoryRecommendationPriority;
  title: string;
  action: string;
  severity: RepositoryRecommendationSeverity;
}

export interface RepositoryIntelligenceHealthCard {
  title: string;
  value: string | number | boolean;
  tone: RepositoryPresentationTone;
}

export interface RepositoryIntelligenceReadinessCard {
  title: string;
  status: RepositoryIntelligenceReport["aiReadiness"]["level"];
  ready: boolean;
  score: number;
  blockers: string[];
  warnings: string[];
  tone: RepositoryPresentationTone;
}

export interface RepositoryIntelligenceQuickStats {
  recommendations: number;
  warnings: number;
  critical: number;
  indexed: boolean;
  stale: boolean;
}

export interface RepositoryIntelligencePresentation {
  heroCard: RepositoryIntelligenceHeroCard;
  overviewCards: RepositoryIntelligenceOverviewCard[];
  recommendationCards: RepositoryIntelligenceRecommendationCard[];
  healthCards: RepositoryIntelligenceHealthCard[];
  readinessCard: RepositoryIntelligenceReadinessCard;
  timelinePreview: RepositoryActivityTimelineItem[];
  quickStats: RepositoryIntelligenceQuickStats;
}

function toneForStatus(
  status: RepositoryIntelligenceReportStatus,
): RepositoryPresentationTone {
  if (status === "healthy") return "success";
  if (status === "blocked" || status === "missing") return "critical";
  if (status === "stale" || status === "degraded") return "warning";
  return "info";
}

function badgeForStatus(status: RepositoryIntelligenceReportStatus): string {
  if (status === "healthy") return "AI-ready";
  if (status === "blocked") return "Blocked";
  if (status === "missing") return "Not indexed";
  if (status === "stale") return "Re-index needed";
  if (status === "degraded") return "Degraded";
  return "Unknown";
}

function toneForReadiness(
  status: RepositoryIntelligenceReport["aiReadiness"]["level"],
): RepositoryPresentationTone {
  if (status === "ready") return "success";
  if (status === "blocked") return "critical";
  return "warning";
}

function toneForBoolean(value: boolean): RepositoryPresentationTone {
  return value ? "success" : "warning";
}

function copyTimelinePreview(
  timeline: readonly RepositoryActivityTimelineItem[],
): RepositoryActivityTimelineItem[] {
  return timeline.slice(0, 5).map((item) => ({
    ...item,
    metadata: { ...item.metadata },
  }));
}

export function buildRepositoryIntelligencePresentation(
  report: RepositoryIntelligenceReport,
): RepositoryIntelligencePresentation {
  const statusTone = toneForStatus(report.summary.status);

  return {
    heroCard: {
      title: report.summary.headline,
      subtitle: report.summary.explanation,
      status: report.summary.status,
      score: report.overview.score,
      badge: badgeForStatus(report.summary.status),
    },
    overviewCards: [
      {
        title: "Health",
        value: report.overview.health,
        tone: statusTone,
      },
      {
        title: "Readiness",
        value: report.overview.readiness,
        tone: toneForReadiness(report.overview.readiness),
      },
      {
        title: "Indexed",
        value: report.overview.indexed,
        tone: toneForBoolean(report.overview.indexed),
      },
      {
        title: "Recommendations",
        value: report.overview.recommendationCount,
        tone: report.overview.recommendationCount === 0 ? "success" : "info",
      },
    ],
    recommendationCards: report.recommendations.recommendations.map((item) => ({
      priority: item.priority,
      title: item.title,
      action: item.action,
      severity: item.severity,
    })),
    healthCards: [
      {
        title: "Score",
        value: report.health.score,
        tone: statusTone,
      },
      {
        title: "Grade",
        value: report.health.grade,
        tone: statusTone,
      },
      {
        title: "Warnings",
        value: report.health.warnings.length,
        tone: report.health.warnings.length === 0 ? "success" : "warning",
      },
    ],
    readinessCard: {
      title: "AI Readiness",
      status: report.aiReadiness.level,
      ready: report.aiReadiness.ready,
      score: report.aiReadiness.score,
      blockers: [...report.aiReadiness.blockers],
      warnings: [...report.aiReadiness.warnings],
      tone: toneForReadiness(report.aiReadiness.level),
    },
    timelinePreview: copyTimelinePreview(report.timeline),
    quickStats: {
      recommendations: report.recommendations.summary.total,
      warnings:
        report.recommendations.summary.warnings +
        report.health.warnings.length +
        report.aiReadiness.warnings.length,
      critical:
        report.recommendations.summary.critical +
        report.aiReadiness.blockers.length,
      indexed: report.overview.indexed,
      stale: report.overview.stale,
    },
  };
}
