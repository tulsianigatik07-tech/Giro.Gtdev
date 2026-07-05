import { describe, expect, it } from "vitest";

import type { RepositoryActivityTimelineItem } from "../services/repository/repositoryActivityTimeline.js";
import type { RepositoryAiReadinessResult } from "../services/repository/repositoryAiReadinessEngine.js";
import type { RepositoryDashboardSummary } from "../services/repository/repositoryDashboardSummary.js";
import type { RepositoryHealthEngineResult } from "../services/repository/repositoryHealthEngine.js";
import type { RepositoryInsightsEngineResult } from "../services/repository/repositoryInsightsEngine.js";
import {
  buildRepositoryRecommendations,
  type RepositoryRecommendationInput,
} from "../services/repository/repositoryRecommendationEngine.js";

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

function cleanupTimeline(): RepositoryActivityTimelineItem[] {
  return [
    {
      repositoryId: REPOSITORY_ID,
      sequence: 1,
      type: "repository_cleanup_executed",
      label: "Cleanup executed",
      title: "Cleanup plan executed",
      message: "Repository cleanup plan executed.",
      tone: "warning",
      metadata: {
        totalExecuted: 1,
        totalSkipped: 0,
      },
    },
  ];
}

function input(
  overrides: Partial<RepositoryRecommendationInput> = {},
): RepositoryRecommendationInput {
  return {
    dashboard: dashboard(),
    health: health(),
    aiReadiness: aiReadiness(),
    insights: insights(),
    timeline: cleanupTimeline(),
    ...overrides,
  };
}

describe("repository recommendation engine", () => {
  it("handles empty repository signals", () => {
    const missingDashboard = dashboard({
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
      metrics: {
        files: 0,
        chunks: 0,
        symbols: 0,
        graphNodes: 0,
        graphEdges: 0,
      },
    });

    const result = buildRepositoryRecommendations(
      input({
        dashboard: missingDashboard,
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
          warnings: [
            "Repository is not indexed.",
            "Repository is not ready for retrieval.",
          ],
        }),
        aiReadiness: aiReadiness({
          ready: false,
          score: 0,
          level: "blocked",
          blockers: [
            "Repository metadata is missing.",
            "Repository is not indexed.",
          ],
        }),
        timeline: [],
      }),
    );

    expect(result.recommendations.map((item) => item.id)).toEqual([
      "indexing.run-indexing",
      "readiness.resolve-blockers",
      "health.warning.repository-is-not-indexed",
      "health.warning.repository-is-not-ready-for-retrieval",
      "cleanup.run-cleanup",
    ]);
    expect(result.summary).toEqual({
      total: 5,
      critical: 2,
      warnings: 2,
      informational: 1,
    });
  });

  it("returns healthy informational recommendation when no actions are needed", () => {
    const result = buildRepositoryRecommendations(input());

    expect(result.recommendations).toEqual([
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
    ]);
  });

  it("recommends re-indexing for stale repository", () => {
    const result = buildRepositoryRecommendations(
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
            readiness: {
              ...dashboard().status.readiness,
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

    expect(result.recommendations.map((item) => item.id)).toContain(
      "indexing.reindex-stale",
    );
  });

  it("recommends resolving blockers for blocked AI readiness", () => {
    const result = buildRepositoryRecommendations(
      input({
        aiReadiness: aiReadiness({
          ready: false,
          score: 0,
          level: "blocked",
          blockers: ["Repository indexing failed."],
        }),
      }),
    );

    expect(result.recommendations.map((item) => item.id)).toContain(
      "readiness.resolve-blockers",
    );
  });

  it("recommends improving degraded readiness", () => {
    const result = buildRepositoryRecommendations(
      input({
        aiReadiness: aiReadiness({
          ready: false,
          score: 60,
          level: "degraded",
          warnings: ["Repository index is stale."],
        }),
      }),
    );

    expect(result.recommendations.map((item) => item.id)).toContain(
      "readiness.improve-degraded",
    );
  });

  it("adds cleanup recommendation when cleanup has not executed", () => {
    const result = buildRepositoryRecommendations(
      input({
        timeline: [],
      }),
    );

    expect(result.recommendations).toEqual([
      expect.objectContaining({
        id: "cleanup.run-cleanup",
        priority: "low",
        severity: "info",
      }),
    ]);
  });

  it("adds indexing recommendation when repository is not indexed", () => {
    const result = buildRepositoryRecommendations(
      input({
        health: health({
          signals: {
            indexed: false,
            ready: false,
            stale: false,
            hasRecentLifecycleActivity: true,
            cleanupSignalsAvailable: true,
          },
        }),
      }),
    );

    expect(result.recommendations[0]).toEqual(
      expect.objectContaining({
        id: "indexing.run-indexing",
        priority: "critical",
      }),
    );
  });

  it("promotes critical and warning insights into recommendations", () => {
    const result = buildRepositoryRecommendations(
      input({
        insights: insights({
          insights: [
            {
              id: "architecture.graph-risk",
              type: "architecture",
              severity: "critical",
              title: "Architecture graph risk",
              description: "Graph risk is high.",
              recommendation: "Review graph coupling.",
              signals: {
                graphNodes: 10,
              },
            },
            {
              id: "retrieval.single-file-concentration",
              type: "retrieval",
              severity: "warning",
              title: "Retrieval concentrated",
              description: "Retrieval is concentrated in one file.",
              recommendation: "Broaden retrieval coverage.",
              signals: {
                resultCount: 4,
              },
            },
          ],
          summary: {
            total: 2,
            critical: 1,
            warnings: 1,
            successes: 0,
            informational: 0,
          },
        }),
      }),
    );

    expect(result.recommendations.map((item) => item.id)).toEqual([
      "insight.architecture.graph-risk",
      "insight.retrieval.single-file-concentration",
    ]);
  });

  it("sorts recommendations by priority then id", () => {
    const result = buildRepositoryRecommendations(
      input({
        health: health({
          signals: {
            indexed: false,
            ready: false,
            stale: true,
            hasRecentLifecycleActivity: true,
            cleanupSignalsAvailable: false,
          },
          warnings: ["Repository index is stale."],
        }),
        aiReadiness: aiReadiness({
          ready: false,
          level: "blocked",
          blockers: ["Repository is not indexed."],
        }),
        timeline: [],
      }),
    );

    expect(result.recommendations.map((item) => item.id)).toEqual([
      "indexing.run-indexing",
      "readiness.resolve-blockers",
      "health.warning.repository-index-is-stale",
      "indexing.reindex-stale",
      "cleanup.run-cleanup",
    ]);
  });

  it("returns deterministic repeated output", () => {
    const request = input({
      timeline: [],
    });

    expect(buildRepositoryRecommendations(request)).toEqual(
      buildRepositoryRecommendations(request),
    );
  });

  it("does not mutate input", () => {
    const request = input({
      health: health({
        warnings: ["Repository index is stale."],
        recommendations: ["Refresh or reindex the repository to restore freshness."],
      }),
      timeline: [
        {
          ...cleanupTimeline()[0]!,
          metadata: {
            resources: ["symbols", "metadata"],
          },
        },
      ],
    });
    const before = structuredClone(request);

    buildRepositoryRecommendations(request);

    expect(request).toEqual(before);
  });
});
