import { describe, expect, it } from "vitest";

import type { RepositoryActivityTimelineItem } from "../services/repository/repositoryActivityTimeline.js";
import type { RepositoryAiReadinessResult } from "../services/repository/repositoryAiReadinessEngine.js";
import type { RepositoryDashboardSummary } from "../services/repository/repositoryDashboardSummary.js";
import type { RepositoryHealthEngineResult } from "../services/repository/repositoryHealthEngine.js";
import type { RepositoryInsightsEngineResult } from "../services/repository/repositoryInsightsEngine.js";
import {
  buildRepositoryIntelligencePresentation,
} from "../services/repository/repositoryIntelligencePresenter.js";
import type { RepositoryIntelligenceReport } from "../services/repository/repositoryIntelligenceReport.js";
import type { RepositoryRecommendationResult } from "../services/repository/repositoryRecommendationEngine.js";

const REPOSITORY_ID = "acme/demo";

function dashboard(
  overrides: Partial<RepositoryDashboardSummary> = {},
): RepositoryDashboardSummary {
  return {
    repository: REPOSITORY_ID,
    status: {
      repository: REPOSITORY_ID,
      health: {
        repository: REPOSITORY_ID,
        indexed: true,
        healthy: true,
        stale: false,
        status: "indexed",
        lastIndexedAt: "2026-01-01T00:00:00.000Z",
        lastAccessedAt: "2026-01-01T00:00:00.000Z",
      },
      readiness: {
        repository: REPOSITORY_ID,
        ready: true,
        status: "indexed",
        indexedFiles: 4,
        indexedChunks: 8,
        lastIndexedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    metrics: {
      files: 4,
      chunks: 8,
      symbols: 10,
      graphNodes: 3,
      graphEdges: 2,
    },
    ...overrides,
  };
}

function health(
  overrides: Partial<RepositoryHealthEngineResult> = {},
): RepositoryHealthEngineResult {
  return {
    repositoryId: REPOSITORY_ID,
    score: 95,
    grade: "excellent",
    healthy: true,
    signals: {
      indexed: true,
      ready: true,
      stale: false,
      hasRecentLifecycleActivity: true,
      cleanupSignalsAvailable: true,
    },
    warnings: [],
    recommendations: [],
    ...overrides,
  };
}

function aiReadiness(
  overrides: Partial<RepositoryAiReadinessResult> = {},
): RepositoryAiReadinessResult {
  return {
    repositoryId: REPOSITORY_ID,
    ready: true,
    score: 95,
    level: "ready",
    blockers: [],
    warnings: [],
    recommendations: [],
    signals: {
      metadataAvailable: true,
      indexed: true,
      readyForRetrieval: true,
      failed: false,
      stale: false,
      healthScore: 95,
      healthHealthy: true,
      retrievalResultsAvailable: true,
      criticalInsights: 0,
      warningInsights: 0,
    },
    ...overrides,
  };
}

function insights(
  overrides: Partial<RepositoryInsightsEngineResult> = {},
): RepositoryInsightsEngineResult {
  return {
    repositoryId: REPOSITORY_ID,
    insights: [],
    summary: {
      total: 0,
      critical: 0,
      warnings: 0,
      successes: 0,
      informational: 0,
    },
    ...overrides,
  };
}

function recommendations(
  overrides: Partial<RepositoryRecommendationResult> = {},
): RepositoryRecommendationResult {
  return {
    repositoryId: REPOSITORY_ID,
    recommendations: [
      {
        id: "repository.healthy",
        priority: "info",
        severity: "info",
        title: "Repository is healthy",
        description: "Repository signals do not require action.",
        reason: "Health, readiness, insights, and lifecycle signals are in a healthy state.",
        category: "lifecycle",
        action: "Maintain current repository lifecycle practices.",
      },
    ],
    summary: {
      total: 1,
      critical: 0,
      warnings: 0,
      informational: 1,
    },
    ...overrides,
  };
}

function event(sequence: number): RepositoryActivityTimelineItem {
  return {
    repositoryId: REPOSITORY_ID,
    sequence,
    type: "repository_dashboard_viewed",
    label: "Dashboard viewed",
    title: "Dashboard summary viewed",
    message: `Event ${sequence}`,
    tone: "info",
    metadata: {
      sequence,
    },
  };
}

function report(
  overrides: Partial<RepositoryIntelligenceReport> = {},
): RepositoryIntelligenceReport {
  return {
    repositoryId: REPOSITORY_ID,
    overview: {
      score: 95,
      health: "excellent",
      readiness: "ready",
      indexed: true,
      stale: false,
      recommendationCount: 1,
    },
    dashboard: dashboard(),
    health: health(),
    aiReadiness: aiReadiness(),
    insights: insights(),
    recommendations: recommendations(),
    timeline: [event(1)],
    summary: {
      status: "healthy",
      headline: "Repository is healthy and AI-ready.",
      explanation: "Repository signals are healthy and no action-oriented recommendations are pending.",
      strengths: ["Repository is indexed."],
      risks: [],
      nextActions: [],
    },
    ...overrides,
  };
}

describe("repository intelligence presenter", () => {
  it("presents empty report", () => {
    const presentation = buildRepositoryIntelligencePresentation(
      report({
        overview: {
          score: 0,
          health: "poor",
          readiness: "blocked",
          indexed: false,
          stale: false,
          recommendationCount: 1,
        },
        health: health({
          score: 0,
          grade: "poor",
          healthy: false,
          signals: {
            indexed: false,
            ready: false,
            stale: false,
            hasRecentLifecycleActivity: false,
            cleanupSignalsAvailable: false,
          },
        }),
        aiReadiness: aiReadiness({
          ready: false,
          score: 0,
          level: "blocked",
          blockers: ["Repository metadata is missing."],
        }),
        summary: {
          status: "missing",
          headline: "Repository has not been indexed.",
          explanation: "Repository metadata is unavailable.",
          strengths: [],
          risks: ["Repository metadata is missing."],
          nextActions: ["Run indexing."],
        },
      }),
    );

    expect(presentation.heroCard).toEqual({
      title: "Repository has not been indexed.",
      subtitle: "Repository metadata is unavailable.",
      status: "missing",
      score: 0,
      badge: "Not indexed",
    });
    expect(presentation.readinessCard.tone).toBe("critical");
    expect(presentation.quickStats.indexed).toBe(false);
  });

  it("presents healthy report", () => {
    const presentation = buildRepositoryIntelligencePresentation(report());

    expect(presentation.heroCard.badge).toBe("AI-ready");
    expect(presentation.heroCard.score).toBe(95);
    expect(presentation.overviewCards).toEqual([
      { title: "Health", value: "excellent", tone: "success" },
      { title: "Readiness", value: "ready", tone: "success" },
      { title: "Indexed", value: true, tone: "success" },
      { title: "Recommendations", value: 1, tone: "info" },
    ]);
    expect(presentation.readinessCard.ready).toBe(true);
  });

  it("presents blocked report", () => {
    const presentation = buildRepositoryIntelligencePresentation(
      report({
        overview: {
          score: 20,
          health: "poor",
          readiness: "blocked",
          indexed: true,
          stale: false,
          recommendationCount: 1,
        },
        aiReadiness: aiReadiness({
          ready: false,
          score: 20,
          level: "blocked",
          blockers: ["Repository indexing failed."],
        }),
        summary: {
          status: "blocked",
          headline: "Repository is not ready for AI workflows.",
          explanation: "Repository indexing failed.",
          strengths: [],
          risks: ["Repository indexing failed."],
          nextActions: ["Resolve readiness blockers."],
        },
      }),
    );

    expect(presentation.heroCard.badge).toBe("Blocked");
    expect(presentation.heroCard.status).toBe("blocked");
    expect(presentation.readinessCard.tone).toBe("critical");
    expect(presentation.quickStats.critical).toBe(1);
  });

  it("presents degraded report", () => {
    const presentation = buildRepositoryIntelligencePresentation(
      report({
        overview: {
          score: 60,
          health: "fair",
          readiness: "degraded",
          indexed: true,
          stale: false,
          recommendationCount: 1,
        },
        aiReadiness: aiReadiness({
          ready: false,
          score: 60,
          level: "degraded",
          warnings: ["Retrieval returned no results."],
        }),
        summary: {
          status: "degraded",
          headline: "Repository needs attention before full AI use.",
          explanation: "Retrieval returned no results.",
          strengths: ["Repository is indexed."],
          risks: ["Retrieval returned no results."],
          nextActions: ["Improve readiness before relying on AI answers."],
        },
      }),
    );

    expect(presentation.heroCard.badge).toBe("Degraded");
    expect(presentation.readinessCard.tone).toBe("warning");
    expect(presentation.quickStats.warnings).toBe(1);
  });

  it("limits timeline preview to first five events", () => {
    const presentation = buildRepositoryIntelligencePresentation(
      report({
        timeline: [1, 2, 3, 4, 5, 6].map(event),
      }),
    );

    expect(presentation.timelinePreview.map((item) => item.sequence)).toEqual([
      1,
      2,
      3,
      4,
      5,
    ]);
  });

  it("maps recommendation cards", () => {
    const presentation = buildRepositoryIntelligencePresentation(
      report({
        recommendations: recommendations({
          recommendations: [
            {
              id: "readiness.resolve-blockers",
              priority: "critical",
              severity: "critical",
              title: "Resolve AI readiness blockers",
              description: "Repository is blocked.",
              reason: "AI readiness level is blocked.",
              category: "readiness",
              action: "Resolve readiness blockers.",
            },
          ],
          summary: {
            total: 1,
            critical: 1,
            warnings: 0,
            informational: 0,
          },
        }),
      }),
    );

    expect(presentation.recommendationCards).toEqual([
      {
        priority: "critical",
        title: "Resolve AI readiness blockers",
        action: "Resolve readiness blockers.",
        severity: "critical",
      },
    ]);
  });

  it("builds quick stats", () => {
    const presentation = buildRepositoryIntelligencePresentation(
      report({
        overview: {
          score: 70,
          health: "good",
          readiness: "degraded",
          indexed: true,
          stale: true,
          recommendationCount: 2,
        },
        health: health({
          warnings: ["Repository index is stale."],
          signals: {
            indexed: true,
            ready: true,
            stale: true,
            hasRecentLifecycleActivity: true,
            cleanupSignalsAvailable: false,
          },
        }),
        aiReadiness: aiReadiness({
          ready: false,
          level: "degraded",
          warnings: ["Repository index is stale."],
        }),
        recommendations: recommendations({
          summary: {
            total: 2,
            critical: 1,
            warnings: 1,
            informational: 0,
          },
        }),
      }),
    );

    expect(presentation.quickStats).toEqual({
      recommendations: 2,
      warnings: 3,
      critical: 1,
      indexed: true,
      stale: true,
    });
  });

  it("is deterministic", () => {
    const source = report();

    expect(buildRepositoryIntelligencePresentation(source)).toEqual(
      buildRepositoryIntelligencePresentation(source),
    );
  });

  it("does not mutate input", () => {
    const source = report({
      timeline: [
        {
          ...event(1),
          metadata: {
            resources: ["symbols", "metadata"],
          },
        },
      ],
    });
    const before = structuredClone(source);

    const presentation = buildRepositoryIntelligencePresentation(source);
    presentation.timelinePreview[0]!.metadata.resources = ["mutated"];

    expect(source).toEqual(before);
  });
});
