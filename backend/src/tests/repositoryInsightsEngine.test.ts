import { describe, expect, it } from "vitest";

import {
  buildRepositoryInsightsEngineResult,
  type RepositoryInsightsEngineInput,
} from "../services/repository/repositoryInsightsEngine.js";
import type { RepositoryActivityTimelineItem } from "../services/repository/repositoryActivityTimeline.js";
import type { RepositoryDashboardSummary } from "../services/repository/repositoryDashboardSummary.js";
import type { RepositoryHealthEngineResult } from "../services/repository/repositoryHealthEngine.js";
import type { RetrievalExplainabilitySummary } from "../services/retrieval/retrievalExplainabilitySummary.js";

const REPOSITORY_ID = "acme/demo";

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
      cleanupSignalsAvailable: false,
    },
    warnings: [],
    recommendations: [],
    ...overrides,
  };
}

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
      symbols: 12,
      graphNodes: 3,
      graphEdges: 2,
    },
    ...overrides,
  };
}

function timelineItem(
  overrides: Partial<RepositoryActivityTimelineItem> = {},
): RepositoryActivityTimelineItem {
  return {
    repositoryId: REPOSITORY_ID,
    sequence: 1,
    type: "repository_dashboard_viewed",
    label: "Dashboard viewed",
    title: "Dashboard summary viewed",
    message: "Repository dashboard summary viewed.",
    tone: "info",
    metadata: {},
    ...overrides,
  };
}

function retrieval(
  overrides: Partial<RetrievalExplainabilitySummary> = {},
): RetrievalExplainabilitySummary {
  return {
    totalResults: 3,
    sourceBreakdown: {
      semantic: 2,
      keyword: 1,
      symbol: 0,
      graph: 0,
      fileSearch: 0,
    },
    topFiles: [
      {
        filePath: "src/a.ts",
        resultCount: 2,
        maxScore: 0.9,
        dominantSource: "semantic",
      },
      {
        filePath: "src/b.ts",
        resultCount: 1,
        maxScore: 0.7,
        dominantSource: "keyword",
      },
    ],
    strongestSignals: [
      {
        source: "semantic",
        filePath: "src/a.ts",
        score: 0.9,
      },
    ],
    warnings: [],
    explanation: [
      "Retrieved 3 result(s) across 2 file(s).",
    ],
    ...overrides,
  };
}

describe("repository insights engine", () => {
  it("1. missing/empty signals produce deterministic baseline insight", () => {
    const result = buildRepositoryInsightsEngineResult({});

    expect(result).toEqual({
      repositoryId: "unknown",
      insights: [
        {
          id: "baseline.no-signals",
          type: "lifecycle",
          severity: "info",
          title: "Repository signals are unavailable",
          description: "No deterministic repository signals were provided to the insights engine.",
          recommendation: "Index the repository and collect dashboard signals.",
          signals: {
            signalCount: 0,
          },
        },
        {
          id: "lifecycle.no-activity",
          type: "lifecycle",
          severity: "info",
          title: "No lifecycle activity recorded",
          description: "No deterministic lifecycle events are available for this repository.",
          recommendation: "Open the repository dashboard or run a lifecycle operation.",
          signals: {
            eventCount: 0,
          },
        },
      ],
      summary: {
        total: 2,
        critical: 0,
        warnings: 0,
        successes: 0,
        informational: 2,
      },
    });
  });

  it("2. healthy repository produces success insight", () => {
    const result = buildRepositoryInsightsEngineResult({
      health: health(),
      dashboard: dashboard(),
      timeline: [timelineItem()],
    });

    expect(result.insights.map((insight) => insight.id)).toContain("health.ready");
    expect(result.insights.map((insight) => insight.id)).toContain("indexing.ready");
    expect(result.summary.successes).toBe(2);
  });

  it("3. unhealthy stale repository produces warning and critical insights", () => {
    const staleDashboard = dashboard({
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
          ready: false,
          status: "stale",
        },
      },
    });

    const result = buildRepositoryInsightsEngineResult({
      health: health({
        score: 30,
        grade: "poor",
        healthy: false,
        signals: {
          indexed: false,
          ready: false,
          stale: true,
          hasRecentLifecycleActivity: false,
          cleanupSignalsAvailable: false,
        },
        warnings: ["Repository index is stale."],
        recommendations: ["Refresh or reindex the repository to restore freshness."],
      }),
      dashboard: staleDashboard,
      timeline: [],
    });

    expect(result.insights.map((insight) => insight.id)).toEqual([
      "health.critical",
      "health.warning.repository-index-is-stale",
      "indexing.stale",
      "lifecycle.no-activity",
      "architecture.graph-signals-available",
    ]);
    expect(result.summary.critical).toBe(1);
    expect(result.summary.warnings).toBe(3);
  });

  it("4. retrieval with no results produces retrieval warning", () => {
    const result = buildRepositoryInsightsEngineResult({
      repositoryId: REPOSITORY_ID,
      retrievalExplainability: retrieval({
        totalResults: 0,
        sourceBreakdown: {
          semantic: 0,
          keyword: 0,
          symbol: 0,
          graph: 0,
          fileSearch: 0,
        },
        topFiles: [],
        strongestSignals: [],
      }),
      timeline: [],
    });

    expect(result.insights.map((insight) => insight.id)).toContain("retrieval.no-results");
    expect(result.summary.warnings).toBe(1);
  });

  it("5. retrieval with multiple top files produces grounding success insight", () => {
    const result = buildRepositoryInsightsEngineResult({
      repositoryId: REPOSITORY_ID,
      retrievalExplainability: retrieval(),
      timeline: [],
    });

    expect(result.insights.map((insight) => insight.id)).toContain(
      "retrieval.semantic-dominant",
    );
    expect(result.insights.map((insight) => insight.id)).toContain(
      "retrieval.multi-file-grounding",
    );
    expect(result.summary.successes).toBe(1);
  });

  it("6. cleanup/timeline events produce lifecycle and cleanup insights", () => {
    const result = buildRepositoryInsightsEngineResult({
      repositoryId: REPOSITORY_ID,
      timeline: [
        timelineItem({
          sequence: 2,
          type: "repository_cleanup_reported",
          label: "Cleanup reported",
          title: "Cleanup report created",
          message: "Repository cleanup report built.",
          metadata: {
            totalExecuted: 4,
            totalSkipped: 1,
            success: false,
          },
        }),
      ],
    });

    expect(result.insights.map((insight) => insight.id)).toEqual([
      "cleanup.skipped-resources",
      "lifecycle.activity-recorded",
    ]);
    expect(result.summary.warnings).toBe(1);
    expect(result.summary.informational).toBe(1);
  });

  it("7. insight summary counts are correct", () => {
    const result = buildRepositoryInsightsEngineResult({
      health: health(),
      dashboard: dashboard(),
      retrievalExplainability: retrieval(),
      timeline: [
        timelineItem({
          type: "repository_cleanup_reported",
          metadata: {
            totalExecuted: 2,
            totalSkipped: 0,
          },
        }),
      ],
    });

    expect(result.summary).toEqual({
      total: 7,
      critical: 0,
      warnings: 0,
      successes: 4,
      informational: 3,
    });
  });

  it("8. stable ordering and stable IDs", () => {
    const input: RepositoryInsightsEngineInput = {
      health: health(),
      dashboard: dashboard(),
      retrievalExplainability: retrieval(),
      timeline: [timelineItem()],
    };

    const result = buildRepositoryInsightsEngineResult(input);

    expect(result.insights.map((insight) => insight.id)).toEqual([
      "health.ready",
      "indexing.ready",
      "retrieval.semantic-dominant",
      "retrieval.multi-file-grounding",
      "lifecycle.activity-recorded",
      "architecture.graph-signals-available",
    ]);
  });

  it("9. input objects are not mutated", () => {
    const input: RepositoryInsightsEngineInput = {
      health: health({
        warnings: ["Repository index is stale."],
        recommendations: ["Refresh or reindex the repository to restore freshness."],
      }),
      dashboard: dashboard(),
      retrievalExplainability: retrieval(),
      timeline: [
        timelineItem({
          metadata: {
            resources: ["symbols", "metadata"],
          },
        }),
      ],
    };
    const before = structuredClone(input);

    buildRepositoryInsightsEngineResult(input);

    expect(input).toEqual(before);
  });

  it("10. repeated output is deterministic", () => {
    const input: RepositoryInsightsEngineInput = {
      health: health(),
      dashboard: dashboard(),
      retrievalExplainability: retrieval(),
      timeline: [timelineItem()],
    };

    expect(buildRepositoryInsightsEngineResult(input)).toEqual(
      buildRepositoryInsightsEngineResult(input),
    );
  });
});
