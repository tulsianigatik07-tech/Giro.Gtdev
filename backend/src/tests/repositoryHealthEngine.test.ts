import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRepositoryIndexRegistry,
  markRepositoryStale,
  setRepositoryIndexed,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import { buildRepositoryDashboardSummary } from "../services/repository/repositoryDashboardSummary.js";
import {
  buildRepositoryHealthEngineResult,
  buildRepositoryHealthEngineResultForRepository,
} from "../services/repository/repositoryHealthEngine.js";
import {
  clearRepositoryLifecycleEvents,
  recordRepositoryLifecycleEvent,
  type RepositoryLifecycleEvent,
} from "../services/repository/repositoryLifecycleEvents.js";

const OWNER = "acme";
const REPO = "demo";
const REPO_ID = `${OWNER}/${REPO}`;

const COUNTS: IndexedCounts = {
  chunkCount: 10,
  fileCount: 5,
  symbolCount: 12,
  graphNodeCount: 4,
  graphEdgeCount: 6,
  summaryAvailable: true,
};

function dashboard() {
  return buildRepositoryDashboardSummary(OWNER, REPO);
}

function lifecycleEvent(
  input: Partial<RepositoryLifecycleEvent> = {},
): RepositoryLifecycleEvent {
  return {
    repositoryId: input.repositoryId ?? REPO_ID,
    sequence: input.sequence ?? 1,
    type: input.type ?? "repository_dashboard_viewed",
    message: input.message ?? "Repository dashboard summary viewed.",
    metadata: input.metadata ?? {},
  };
}

beforeEach(() => {
  clearRepositoryIndexRegistry();
  clearRepositoryLifecycleEvents();
});

describe("repository health engine", () => {
  it("returns low health for a missing repository", () => {
    const result = buildRepositoryHealthEngineResult({
      dashboard: dashboard(),
      events: [],
    });

    expect(result).toEqual({
      repositoryId: REPO_ID,
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
      recommendations: [
        "Complete repository indexing to make retrieval available.",
        "Index the repository before relying on dashboard insights.",
        "Open the repository dashboard to record lifecycle activity.",
      ],
    });
  });

  it("returns high health for an indexed ready repository", () => {
    setRepositoryIndexed(OWNER, REPO, COUNTS);

    const result = buildRepositoryHealthEngineResult({
      dashboard: dashboard(),
      events: [
        lifecycleEvent({
          type: "repository_dashboard_viewed",
          sequence: 1,
        }),
      ],
    });

    expect(result.score).toBe(95);
    expect(result.grade).toBe("excellent");
    expect(result.healthy).toBe(true);
    expect(result.signals).toEqual({
      indexed: true,
      ready: true,
      stale: false,
      hasRecentLifecycleActivity: true,
      cleanupSignalsAvailable: false,
    });
    expect(result.warnings).toEqual([]);
    expect(result.recommendations).toEqual([]);
  });

  it("reduces score and adds warning for a stale repository", () => {
    setRepositoryIndexed(OWNER, REPO, COUNTS);
    markRepositoryStale(OWNER, REPO);

    const result = buildRepositoryHealthEngineResult({
      dashboard: dashboard(),
      events: [lifecycleEvent()],
    });

    expect(result.score).toBe(0);
    expect(result.grade).toBe("poor");
    expect(result.healthy).toBe(false);
    expect(result.signals.stale).toBe(true);
    expect(result.warnings).toContain("Repository index is stale.");
    expect(result.recommendations).toContain(
      "Refresh or reindex the repository to restore freshness.",
    );
  });

  it("uses lifecycle events to improve activity signal and cleanup confidence", () => {
    setRepositoryIndexed(OWNER, REPO, COUNTS);

    const result = buildRepositoryHealthEngineResult({
      dashboard: dashboard(),
      events: [
        lifecycleEvent({
          sequence: 1,
          type: "repository_cleanup_planned",
          message: "Repository cleanup plan built.",
          metadata: {
            cleanupRequired: true,
            totalResources: 2,
          },
        }),
        lifecycleEvent({
          sequence: 2,
          type: "repository_cleanup_reported",
          message: "Repository cleanup report built.",
          metadata: {
            success: false,
            totalExecuted: 2,
            totalSkipped: 1,
          },
        }),
      ],
    });

    expect(result.score).toBe(95);
    expect(result.signals.hasRecentLifecycleActivity).toBe(true);
    expect(result.signals.cleanupSignalsAvailable).toBe(true);
    expect(result.warnings).toEqual([
      "Cleanup skipped unsupported resources.",
    ]);
    expect(result.recommendations).toEqual([
      "Review cleanup warnings before reconnecting the repository.",
    ]);
  });

  it("builds deterministic recommendations", () => {
    const result = buildRepositoryHealthEngineResult({
      dashboard: dashboard(),
      events: [
        lifecycleEvent({
          type: "repository_cleanup_failed",
          metadata: {
            error: "boom",
          },
        }),
      ],
    });

    expect(result.recommendations).toEqual([
      "Complete repository indexing to make retrieval available.",
      "Index the repository before relying on dashboard insights.",
      "Retry cleanup after resolving the reported failure.",
    ]);
    expect(result.warnings).toEqual([
      "Repository cleanup failed.",
      "Repository is not indexed.",
      "Repository is not ready for retrieval.",
    ]);
  });

  it("returns stable output across repeated calls", () => {
    setRepositoryIndexed(OWNER, REPO, COUNTS);
    const input = {
      dashboard: dashboard(),
      events: [lifecycleEvent()],
    };

    expect(buildRepositoryHealthEngineResult(input)).toEqual(
      buildRepositoryHealthEngineResult(input),
    );
  });

  it("does not mutate event input", () => {
    setRepositoryIndexed(OWNER, REPO, COUNTS);
    const events = [
      lifecycleEvent({
        metadata: {
          resources: ["symbols", "metadata"],
        },
      }),
    ];
    const before = structuredClone(events);

    buildRepositoryHealthEngineResult({
      dashboard: dashboard(),
      events,
    });

    expect(events).toEqual(before);
  });

  it("can read deterministic repository signals from existing services", () => {
    setRepositoryIndexed(OWNER, REPO, COUNTS);
    recordRepositoryLifecycleEvent({
      repositoryId: REPO_ID,
      type: "repository_dashboard_viewed",
      message: "Repository dashboard summary viewed.",
    });

    const result = buildRepositoryHealthEngineResultForRepository(OWNER, REPO);

    expect(result.repositoryId).toBe(REPO_ID);
    expect(result.score).toBe(95);
    expect(result.healthy).toBe(true);
    expect(result.signals.hasRecentLifecycleActivity).toBe(true);
  });
});
