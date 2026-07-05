// Canonical product-facing repository intelligence report. Pure deterministic
// composition over existing repository intelligence layers: no routes,
// persistence, async work, I/O, timestamps, randomness, global state, or
// mutation.

import type { RepositoryActivityTimelineItem } from "./repositoryActivityTimeline.js";
import type { RepositoryAiReadinessResult } from "./repositoryAiReadinessEngine.js";
import type { RepositoryDashboardSummary } from "./repositoryDashboardSummary.js";
import type { RepositoryHealthEngineResult } from "./repositoryHealthEngine.js";
import type { RepositoryInsightsEngineResult } from "./repositoryInsightsEngine.js";
import type { RepositoryRecommendationResult } from "./repositoryRecommendationEngine.js";

export type RepositoryIntelligenceReportStatus =
  | "healthy"
  | "degraded"
  | "blocked"
  | "stale"
  | "missing";

export interface RepositoryIntelligenceReportOverview {
  score: number;
  health: RepositoryHealthEngineResult["grade"];
  readiness: RepositoryAiReadinessResult["level"];
  indexed: boolean;
  stale: boolean;
  recommendationCount: number;
}

export interface RepositoryIntelligenceReportSummary {
  status: RepositoryIntelligenceReportStatus;
  headline: string;
  explanation: string;
  strengths: string[];
  risks: string[];
  nextActions: string[];
}

export interface RepositoryIntelligenceReportInput {
  dashboard: RepositoryDashboardSummary;
  health: RepositoryHealthEngineResult;
  aiReadiness: RepositoryAiReadinessResult;
  insights: RepositoryInsightsEngineResult;
  recommendations: RepositoryRecommendationResult;
  timeline: readonly RepositoryActivityTimelineItem[];
}

export interface RepositoryIntelligenceReport {
  repositoryId: string;
  overview: RepositoryIntelligenceReportOverview;
  dashboard: RepositoryDashboardSummary;
  health: RepositoryHealthEngineResult;
  aiReadiness: RepositoryAiReadinessResult;
  insights: RepositoryInsightsEngineResult;
  recommendations: RepositoryRecommendationResult;
  timeline: RepositoryActivityTimelineItem[];
  summary: RepositoryIntelligenceReportSummary;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].filter((value) => value.length > 0);
}

function statusFor(
  input: RepositoryIntelligenceReportInput,
): RepositoryIntelligenceReportStatus {
  if (input.dashboard.status.health.status === "missing") return "missing";
  if (input.aiReadiness.level === "blocked") return "blocked";
  if (input.health.signals.stale || input.dashboard.status.health.stale) return "stale";
  if (input.aiReadiness.level === "degraded") return "degraded";
  return "healthy";
}

function headlineFor(status: RepositoryIntelligenceReportStatus): string {
  if (status === "missing") return "Repository has not been indexed.";
  if (status === "blocked") return "Repository is not ready for AI workflows.";
  if (status === "stale") return "Repository requires re-indexing.";
  if (status === "degraded") return "Repository needs attention before full AI use.";
  return "Repository is healthy and AI-ready.";
}

function explanationFor(
  status: RepositoryIntelligenceReportStatus,
  input: RepositoryIntelligenceReportInput,
): string {
  if (status === "missing") {
    return "Repository metadata is unavailable, so Giro cannot build a complete intelligence report.";
  }

  if (status === "blocked") {
    return (
      input.aiReadiness.blockers[0] ??
      "AI readiness blockers must be resolved before using repository intelligence."
    );
  }

  if (status === "stale") {
    return "Repository index is stale, so dashboard and AI context may not reflect the latest code.";
  }

  if (status === "degraded") {
    return (
      input.aiReadiness.warnings[0] ??
      "Repository is usable, but warnings reduce confidence in AI-assisted workflows."
    );
  }

  if (
    input.recommendations.recommendations.length === 1 &&
    input.recommendations.recommendations[0]?.id === "repository.healthy"
  ) {
    return "Repository signals are healthy and no action-oriented recommendations are pending.";
  }

  return "Repository intelligence is operating normally.";
}

function strengthsFor(input: RepositoryIntelligenceReportInput): string[] {
  const strengths: string[] = [];

  if (input.health.signals.indexed) {
    strengths.push("Repository is indexed.");
  }

  if (input.health.signals.ready) {
    strengths.push("Repository is ready for retrieval.");
  }

  if (input.aiReadiness.ready) {
    strengths.push("Repository is AI-ready.");
  }

  if (input.insights.summary.successes > 0) {
    strengths.push("Repository has positive intelligence insights.");
  }

  if (input.timeline.length > 0) {
    strengths.push("Repository lifecycle activity is available.");
  }

  return unique(strengths);
}

function risksFor(input: RepositoryIntelligenceReportInput): string[] {
  const risks: string[] = [];

  risks.push(...input.aiReadiness.blockers);
  risks.push(...input.aiReadiness.warnings);
  risks.push(...input.health.warnings);

  for (const insight of input.insights.insights) {
    if (insight.severity === "critical" || insight.severity === "warning") {
      risks.push(insight.description);
    }
  }

  return unique(risks);
}

function nextActionsFor(input: RepositoryIntelligenceReportInput): string[] {
  return unique(
    input.recommendations.recommendations
      .filter((recommendation) => recommendation.id !== "repository.healthy")
      .map((recommendation) => recommendation.action),
  );
}

function copyTimeline(
  timeline: readonly RepositoryActivityTimelineItem[],
): RepositoryActivityTimelineItem[] {
  return timeline.map((item) => ({
    ...item,
    metadata: { ...item.metadata },
  }));
}

export function buildRepositoryIntelligenceReport(
  input: RepositoryIntelligenceReportInput,
): RepositoryIntelligenceReport {
  const status = statusFor(input);
  const timeline = copyTimeline(input.timeline);

  return {
    repositoryId: input.dashboard.repository,
    overview: {
      score: input.health.score,
      health: input.health.grade,
      readiness: input.aiReadiness.level,
      indexed: input.health.signals.indexed,
      stale: input.health.signals.stale,
      recommendationCount: input.recommendations.recommendations.length,
    },
    dashboard: input.dashboard,
    health: input.health,
    aiReadiness: input.aiReadiness,
    insights: input.insights,
    recommendations: input.recommendations,
    timeline,
    summary: {
      status,
      headline: headlineFor(status),
      explanation: explanationFor(status, input),
      strengths: strengthsFor(input),
      risks: risksFor(input),
      nextActions: nextActionsFor(input),
    },
  };
}
