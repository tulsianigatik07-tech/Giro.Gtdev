import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RepositoryAiReadinessResult } from "../services/repository/repositoryAiReadinessEngine.js";
import type { RepositoryHealthEngineResult } from "../services/repository/repositoryHealthEngine.js";
import type { RepositoryHotspotReport } from "../services/repository/repositoryHotspotAnalyzer.js";
import type { RepositoryRiskReport } from "../services/repository/repositoryRiskAnalyzer.js";
import {
  simulateRepositoryHealthTimeline,
  type RepositoryHealthTimelineReport,
} from "../services/repository/repositoryHealthTimelineSimulator.js";

function health(
  score: number,
  overrides: Partial<RepositoryHealthEngineResult> = {},
): RepositoryHealthEngineResult {
  return {
    repositoryId: "acme/demo",
    score,
    grade: score >= 90 ? "excellent" : score >= 70 ? "good" : score >= 40 ? "fair" : "poor",
    healthy: score >= 70,
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
  score: number,
  blockers: string[] = [],
  overrides: Partial<RepositoryAiReadinessResult> = {},
): RepositoryAiReadinessResult {
  return {
    repositoryId: "acme/demo",
    ready: score >= 70 && blockers.length === 0,
    score,
    level: blockers.length > 0 || score < 40 ? "blocked" : score < 70 ? "degraded" : "ready",
    blockers,
    warnings: [],
    recommendations: [],
    signals: {
      metadataAvailable: true,
      indexed: true,
      readyForRetrieval: true,
      failed: false,
      stale: false,
      healthScore: score,
      healthHealthy: score >= 70,
      retrievalResultsAvailable: true,
      criticalInsights: 0,
      warningInsights: 0,
    },
    ...overrides,
  };
}

function risk(
  score: number,
  blockers: string[] = [],
  overrides: Partial<RepositoryRiskReport> = {},
): RepositoryRiskReport {
  return {
    repositoryId: "acme/demo",
    score,
    level: score >= 80 ? "CRITICAL" : score >= 55 ? "HIGH" : score >= 25 ? "MEDIUM" : "LOW",
    summary: `Repository risk is ${score}.`,
    strengths: [],
    risks: [],
    blockers,
    signals: {
      healthy: score < 25,
      indexed: true,
      ready: true,
      stale: false,
      healthScore: 90,
      architectureComplexityScore: 20,
      totalFiles: 4,
      totalDependencies: 3,
      circularDependencyCount: 0,
      dependencyHubCount: 0,
      criticalHotspots: 0,
      highHotspots: 0,
      mediumHotspots: 0,
      lowHotspots: 0,
      criticalInsights: 0,
      warningInsights: 0,
      failedIndexingSignals: 0,
    },
    ...overrides,
  };
}

function hotspots(count = 0): RepositoryHotspotReport {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `hotspot-${index + 1}`,
    type: "dependency_hub" as const,
    severity: "high" as const,
    title: `Hotspot ${index + 1}`,
    description: "Hotspot",
    affectedModules: [`src/hotspot-${index + 1}.ts`],
    reason: "Hotspot detected.",
  }));

  return {
    repositoryId: "acme/demo",
    hotspots: items,
    summary: {
      critical: 0,
      high: count,
      medium: 0,
      low: 0,
    },
  };
}

function report(overrides: Partial<RepositoryHealthTimelineReport> = {}): RepositoryHealthTimelineReport {
  return {
    repositoryId: "acme/demo",
    health: health(90),
    aiReadiness: aiReadiness(90),
    risk: risk(10),
    hotspots: hotspots(0),
    ...overrides,
  };
}

describe("repository health timeline simulator", () => {
  it("simulates a healthy repository with no actions", () => {
    const result = simulateRepositoryHealthTimeline({
      report: report(),
      actions: [],
    });

    assert.equal(result.initialScore, 90);
    assert.equal(result.finalScore, 90);
    assert.deepEqual(result.timeline, []);
    assert.deepEqual(result.remainingBlockers, []);
    assert.equal(result.estimatedReadiness, "ready");
    assert.equal(result.summary, "Repository health remains stable.");
  });

  it("simulates a blocked repository being indexed", () => {
    const result = simulateRepositoryHealthTimeline({
      report: report({
        health: health(25, {
          signals: {
            indexed: false,
            ready: false,
            stale: false,
            hasRecentLifecycleActivity: false,
            cleanupSignalsAvailable: false,
          },
        }),
        aiReadiness: aiReadiness(15, ["Repository is not indexed."], {
          signals: {
            metadataAvailable: true,
            indexed: false,
            readyForRetrieval: false,
            failed: false,
            stale: false,
            healthScore: 25,
            healthHealthy: false,
            retrievalResultsAvailable: null,
            criticalInsights: 0,
            warningInsights: 0,
          },
        }),
        risk: risk(85, ["Index the repository before relying on analysis."]),
      }),
      actions: ["index_repository"],
    });

    assert.equal(result.finalScore, 50);
    assert.equal(result.timeline[0]?.riskLevel, "HIGH");
    assert.deepEqual(result.remainingBlockers, []);
  });

  it("simulates multiple improvement actions", () => {
    const result = simulateRepositoryHealthTimeline({
      report: report({
        health: health(40, {
          signals: {
            indexed: true,
            ready: true,
            stale: true,
            hasRecentLifecycleActivity: true,
            cleanupSignalsAvailable: true,
          },
        }),
        aiReadiness: aiReadiness(45, ["Resolve readiness blockers before using AI analysis."]),
        risk: risk(70, [
          "Resolve readiness blockers before using AI analysis.",
          "Resolve critical architecture hotspots.",
        ]),
        hotspots: hotspots(1),
      }),
      actions: [
        "cleanup_stale_repository",
        "resolve_blocker",
        "remove_hotspot",
        "improve_ai_readiness",
      ],
    });

    assert.equal(result.finalScore, 72);
    assert.equal(result.estimatedReadiness, "ready");
    assert.equal(result.timeline.length, 4);
    assert.deepEqual(result.remainingBlockers, []);
  });

  it("simulates hotspot removal", () => {
    const result = simulateRepositoryHealthTimeline({
      report: report({
        health: health(60),
        risk: risk(45, ["Resolve critical architecture hotspots."]),
        hotspots: hotspots(2),
      }),
      actions: ["remove_hotspot"],
    });

    assert.equal(result.finalScore, 66);
    assert.equal(result.timeline[0]?.riskLevel, "MEDIUM");
    assert.deepEqual(result.remainingBlockers, []);
  });

  it("simulates complexity reduction", () => {
    const result = simulateRepositoryHealthTimeline({
      report: report({
        health: health(65),
        risk: risk(50),
      }),
      actions: ["reduce_complexity"],
    });

    assert.equal(result.finalScore, 72);
    assert.deepEqual(result.improvements, ["Architecture complexity reduced."]);
  });

  it("simulates AI readiness improvement", () => {
    const result = simulateRepositoryHealthTimeline({
      report: report({
        health: health(55),
        aiReadiness: aiReadiness(35, ["Repository is not ready for retrieval."]),
        risk: risk(55, ["Resolve readiness blockers before using AI analysis."]),
      }),
      actions: ["improve_ai_readiness"],
    });

    assert.equal(result.timeline[0]?.aiReadiness, "ready");
    assert.deepEqual(result.remainingBlockers, []);
  });

  it("returns deterministic ordering", () => {
    const result = simulateRepositoryHealthTimeline({
      report: report({
        health: health(50),
        aiReadiness: aiReadiness(35, ["z blocker", "a blocker"]),
        risk: risk(65, ["m blocker", "a blocker"]),
      }),
      actions: ["resolve_architecture_warning", "resolve_blocker"],
    });

    assert.deepEqual(result.improvements, [
      "Architecture warning resolved.",
      "One blocker resolved.",
    ]);
    assert.deepEqual(result.remainingBlockers, ["m blocker", "z blocker"]);
  });

  it("returns the same output for repeated execution", () => {
    const input = {
      report: report({
        health: health(50),
        aiReadiness: aiReadiness(40, ["Repository is not ready for retrieval."]),
        risk: risk(60, ["Resolve readiness blockers before using AI analysis."]),
      }),
      actions: ["resolve_blocker", "improve_ai_readiness"] as const,
    };

    assert.deepEqual(
      simulateRepositoryHealthTimeline(input),
      simulateRepositoryHealthTimeline(input),
    );
  });

  it("does not mutate input report", () => {
    const input = {
      report: report({
        aiReadiness: aiReadiness(35, ["Repository is not ready for retrieval."]),
        risk: risk(55, ["Resolve readiness blockers before using AI analysis."]),
        hotspots: hotspots(1),
      }),
      actions: ["improve_ai_readiness", "remove_hotspot"] as const,
    };
    const before = JSON.stringify(input);

    const result = simulateRepositoryHealthTimeline(input);
    result.timeline[0]!.summary = "mutated";
    result.remainingBlockers.push("mutated");
    result.improvements.push("mutated");

    assert.equal(JSON.stringify(input), before);
    assert.notEqual(simulateRepositoryHealthTimeline(input).timeline[0]?.summary, "mutated");
  });
});
