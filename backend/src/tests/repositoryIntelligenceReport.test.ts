import { describe, expect, it } from "vitest";

import type { RepositoryActivityTimelineItem } from "../services/repository/repositoryActivityTimeline.js";
import type { RepositoryAiReadinessResult } from "../services/repository/repositoryAiReadinessEngine.js";
import type { RepositoryDashboardSummary } from "../services/repository/repositoryDashboardSummary.js";
import type { RepositoryHealthEngineResult } from "../services/repository/repositoryHealthEngine.js";
import type { RepositoryInsightsEngineResult } from "../services/repository/repositoryInsightsEngine.js";
import {
  buildRepositoryIntelligenceReport,
  type RepositoryIntelligenceReportInput,
} from "../services/repository/repositoryIntelligenceReport.js";
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

function timeline(
  overrides: Partial<RepositoryActivityTimelineItem> = {},
): RepositoryActivityTimelineItem[] {
  return [
    {
      repositoryId: REPOSITORY_ID,
      sequence: 1,
      type: "repository_dashboard_viewed",
      label: "Dashboard viewed",
      title: "Dashboard summary viewed",
      message: "Repository dashboard summary viewed.",
      tone: "info",
      metadata: {
        files: 4,
      },
      ...overrides,
    },
  ];
}

function input(
  overrides: Partial<RepositoryIntelligenceReportInput> = {},
): RepositoryIntelligenceReportInput {
  return {
    dashboard: dashboard(),
    health: health(),
    aiReadiness: aiReadiness(),
    insights: insights(),
    recommendations: recommendations(),
    timeline: timeline(),
    ...overrides,
  };
}

describe("repository intelligence report", () => {
  it("builds report for empty repository", () => {
    const report = buildRepositoryIntelligenceReport(
      input({
        dashboard: dashboard({
          status: {
            ...dashboard().status,
            health: {
              ...dashboard().status.health,
              indexed: false,
              healthy: false,
              stale: false,
              status: "missing",
            },
            readiness: {
              ...dashboard().status.readiness,
              ready: false,
              status: "missing",
              indexedFiles: 0,
              indexedChunks: 0,
              lastIndexedAt: null,
            },
          },
        }),
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
        recommendations: recommendations({
          recommendations: [
            {
              id: "indexing.run-indexing",
              priority: "critical",
              severity: "critical",
              title: "Index the repository",
              description: "Repository is not indexed.",
              reason: "Repository metadata is missing.",
              category: "indexing",
              action: "Run indexing.",
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

    expect(report.summary.status).toBe("missing");
    expect(report.summary.headline).toBe("Repository has not been indexed.");
    expect(report.overview).toEqual({
      score: 0,
      health: "poor",
      readiness: "blocked",
      indexed: false,
      stale: false,
      recommendationCount: 1,
    });
    expect(report.summary.nextActions).toEqual(["Run indexing."]);
  });

  it("builds report for healthy repository", () => {
    const report = buildRepositoryIntelligenceReport(input());

    expect(report.summary.status).toBe("healthy");
    expect(report.summary.headline).toBe("Repository is healthy and AI-ready.");
    expect(report.summary.explanation).toBe(
      "Repository signals are healthy and no action-oriented recommendations are pending.",
    );
    expect(report.summary.strengths).toEqual([
      "Repository is indexed.",
      "Repository is ready for retrieval.",
      "Repository is AI-ready.",
      "Repository lifecycle activity is available.",
    ]);
    expect(report.summary.risks).toEqual([]);
    expect(report.summary.nextActions).toEqual([]);
  });

  it("builds stale repository summary", () => {
    const report = buildRepositoryIntelligenceReport(
      input({
        dashboard: dashboard({
          status: {
            ...dashboard().status,
            health: {
              ...dashboard().status.health,
              indexed: false,
              healthy: false,
              stale: true,
              status: "stale",
            },
          },
        }),
        health: health({
          healthy: false,
          signals: {
            indexed: false,
            ready: true,
            stale: true,
            hasRecentLifecycleActivity: true,
            cleanupSignalsAvailable: true,
          },
          warnings: ["Repository index is stale."],
        }),
      }),
    );

    expect(report.summary.status).toBe("stale");
    expect(report.summary.headline).toBe("Repository requires re-indexing.");
    expect(report.summary.risks).toEqual(["Repository index is stale."]);
  });

  it("builds blocked repository summary", () => {
    const report = buildRepositoryIntelligenceReport(
      input({
        aiReadiness: aiReadiness({
          ready: false,
          score: 0,
          level: "blocked",
          blockers: ["Repository indexing failed."],
        }),
      }),
    );

    expect(report.summary.status).toBe("blocked");
    expect(report.summary.headline).toBe("Repository is not ready for AI workflows.");
    expect(report.summary.explanation).toBe("Repository indexing failed.");
    expect(report.summary.risks).toEqual(["Repository indexing failed."]);
  });

  it("builds degraded repository summary", () => {
    const report = buildRepositoryIntelligenceReport(
      input({
        aiReadiness: aiReadiness({
          ready: false,
          score: 60,
          level: "degraded",
          warnings: ["Retrieval returned no results."],
        }),
      }),
    );

    expect(report.summary.status).toBe("degraded");
    expect(report.summary.headline).toBe("Repository needs attention before full AI use.");
    expect(report.summary.explanation).toBe("Retrieval returned no results.");
  });

  it("propagates recommendations into next actions", () => {
    const report = buildRepositoryIntelligenceReport(
      input({
        recommendations: recommendations({
          recommendations: [
            {
              id: "readiness.improve-degraded",
              priority: "medium",
              severity: "warning",
              title: "Improve AI readiness",
              description: "Repository is degraded.",
              reason: "Readiness warning exists.",
              category: "readiness",
              action: "Improve readiness before relying on AI answers.",
            },
          ],
          summary: {
            total: 1,
            critical: 0,
            warnings: 1,
            informational: 0,
          },
        }),
      }),
    );

    expect(report.recommendations.recommendations[0]?.id).toBe(
      "readiness.improve-degraded",
    );
    expect(report.summary.nextActions).toEqual([
      "Improve readiness before relying on AI answers.",
    ]);
  });

  it("propagates timeline and returns a defensive copy", () => {
    const sourceTimeline = timeline({
      metadata: {
        resources: ["symbols", "metadata"],
      },
    });
    const report = buildRepositoryIntelligenceReport(
      input({
        timeline: sourceTimeline,
      }),
    );

    expect(report.timeline).toEqual(sourceTimeline);
    report.timeline[0]!.metadata.resources = ["mutated"];
    expect(sourceTimeline[0]?.metadata.resources).toEqual(["symbols", "metadata"]);
  });

  it("generates summary strengths and risks from inputs", () => {
    const report = buildRepositoryIntelligenceReport(
      input({
        insights: insights({
          insights: [
            {
              id: "retrieval.no-results",
              type: "retrieval",
              severity: "warning",
              title: "Retrieval returned no results",
              description: "No retrieval context was selected.",
              signals: {
                totalResults: 0,
              },
            },
          ],
          summary: {
            total: 1,
            critical: 0,
            warnings: 1,
            successes: 0,
            informational: 0,
          },
        }),
      }),
    );

    expect(report.summary.strengths).toContain("Repository is indexed.");
    expect(report.summary.risks).toContain("No retrieval context was selected.");
  });

  it("is deterministic across repeated output", () => {
    const request = input();

    expect(buildRepositoryIntelligenceReport(request)).toEqual(
      buildRepositoryIntelligenceReport(request),
    );
  });

  it("does not mutate input", () => {
    const request = input({
      health: health({
        warnings: ["Repository index is stale."],
      }),
      timeline: timeline({
        metadata: {
          resources: ["symbols", "metadata"],
        },
      }),
    });
    const before = structuredClone(request);

    buildRepositoryIntelligenceReport(request);

    expect(request).toEqual(before);
  });
});
