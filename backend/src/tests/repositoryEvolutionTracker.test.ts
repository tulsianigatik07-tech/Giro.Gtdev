import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RepositoryArchitectureAnalysis } from "../services/repository/repositoryArchitectureAnalyzer.js";
import type { RepositoryAiReadinessResult } from "../services/repository/repositoryAiReadinessEngine.js";
import type { RepositoryHealthEngineResult } from "../services/repository/repositoryHealthEngine.js";
import type {
  RepositoryHotspot,
  RepositoryHotspotReport,
} from "../services/repository/repositoryHotspotAnalyzer.js";
import type { RepositoryInsightsEngineResult } from "../services/repository/repositoryInsightsEngine.js";
import type { RepositoryRiskReport } from "../services/repository/repositoryRiskAnalyzer.js";
import {
  trackRepositoryEvolution,
  type RepositoryEvolutionSnapshot,
} from "../services/repository/repositoryEvolutionTracker.js";

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
  overrides: Partial<RepositoryAiReadinessResult> = {},
): RepositoryAiReadinessResult {
  return {
    repositoryId: "acme/demo",
    ready: score >= 70,
    score,
    level: score >= 70 ? "ready" : score >= 40 ? "degraded" : "blocked",
    blockers: [],
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

function architecture(
  complexity: number,
  overrides: Partial<RepositoryArchitectureAnalysis> = {},
): RepositoryArchitectureAnalysis {
  return {
    totalFiles: 4,
    totalDependencies: 3,
    rootModules: ["src/app.ts"],
    leafModules: ["src/store.ts"],
    isolatedModules: [],
    averageDependencies: 0.75,
    averageDependents: 0.75,
    mostConnectedModules: [],
    circularDependencyCount: 0,
    hasCycles: false,
    architectureComplexityScore: complexity,
    ...overrides,
  };
}

function hotspot(
  id: string,
  severity: RepositoryHotspot["severity"] = "high",
): RepositoryHotspot {
  return {
    id,
    type: "dependency_hub",
    severity,
    title: id,
    description: `${id} description`,
    affectedModules: [`src/${id}.ts`],
    reason: `${id} reason`,
  };
}

function hotspots(
  items: RepositoryHotspot[] = [],
  overrides: Partial<RepositoryHotspotReport> = {},
): RepositoryHotspotReport {
  return {
    repositoryId: "acme/demo",
    hotspots: items,
    summary: {
      critical: items.filter((item) => item.severity === "critical").length,
      high: items.filter((item) => item.severity === "high").length,
      medium: items.filter((item) => item.severity === "medium").length,
      low: items.filter((item) => item.severity === "low").length,
    },
    ...overrides,
  };
}

function insights(
  criticalCount = 0,
  overrides: Partial<RepositoryInsightsEngineResult> = {},
): RepositoryInsightsEngineResult {
  const criticalInsights = Array.from({ length: criticalCount }, (_, index) => ({
    id: `critical-${index + 1}`,
    type: "architecture" as const,
    severity: "critical" as const,
    title: `Critical ${index + 1}`,
    description: "Critical insight",
    signals: {},
  }));

  return {
    repositoryId: "acme/demo",
    insights: criticalInsights,
    summary: {
      total: criticalInsights.length,
      critical: criticalInsights.length,
      warnings: 0,
      successes: 0,
      informational: 0,
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

function snapshot(input: {
  healthScore?: number;
  readinessScore?: number;
  architectureComplexity?: number;
  hotspotItems?: RepositoryHotspot[];
  criticalInsights?: number;
  riskScore?: number;
  blockers?: string[];
  stale?: boolean;
  indexed?: boolean;
  ready?: boolean;
} = {}): RepositoryEvolutionSnapshot {
  const isIndexed = input.indexed ?? true;
  const isReady = input.ready ?? true;
  const stale = input.stale ?? false;

  return {
    repositoryId: "acme/demo",
    health: health(input.healthScore ?? 90, {
      signals: {
        indexed: isIndexed,
        ready: isReady,
        stale,
        hasRecentLifecycleActivity: true,
        cleanupSignalsAvailable: true,
      },
    }),
    aiReadiness: aiReadiness(input.readinessScore ?? 90, {
      signals: {
        metadataAvailable: true,
        indexed: isIndexed,
        readyForRetrieval: isReady,
        failed: false,
        stale,
        healthScore: input.healthScore ?? 90,
        healthHealthy: (input.healthScore ?? 90) >= 70,
        retrievalResultsAvailable: true,
        criticalInsights: input.criticalInsights ?? 0,
        warningInsights: 0,
      },
    }),
    architecture: architecture(input.architectureComplexity ?? 20),
    hotspots: hotspots(input.hotspotItems ?? []),
    insights: insights(input.criticalInsights ?? 0),
    risk: risk(input.riskScore ?? 10, input.blockers ?? []),
  };
}

describe("repository evolution tracker", () => {
  it("detects an improving repository", () => {
    const previous = snapshot({
      healthScore: 60,
      readinessScore: 50,
      architectureComplexity: 70,
      hotspotItems: [hotspot("architecture.dependency-hubs")],
      criticalInsights: 1,
      riskScore: 80,
      blockers: ["Resolve critical architecture hotspots."],
      stale: true,
    });
    const current = snapshot({
      healthScore: 85,
      readinessScore: 80,
      architectureComplexity: 35,
      riskScore: 30,
    });

    const result = trackRepositoryEvolution(previous, current);

    assert.equal(result.trend, "IMPROVING");
    assert.equal(result.healthDelta, 25);
    assert.equal(result.readinessDelta, 30);
    assert.equal(result.riskDelta, -50);
    assert.deepEqual(result.resolvedHotspots.map((item) => item.id), [
      "architecture.dependency-hubs",
    ]);
    assert.deepEqual(result.resolvedBlockers, [
      "Resolve critical architecture hotspots.",
    ]);
  });

  it("detects a stable repository", () => {
    const previous = snapshot();
    const current = snapshot({
      healthScore: 91,
      readinessScore: 89,
      architectureComplexity: 21,
      riskScore: 10,
    });

    const result = trackRepositoryEvolution(previous, current);

    assert.equal(result.trend, "STABLE");
    assert.deepEqual(result.newHotspots, []);
    assert.deepEqual(result.resolvedHotspots, []);
  });

  it("detects a regressing repository", () => {
    const previous = snapshot({
      healthScore: 90,
      readinessScore: 90,
      architectureComplexity: 20,
      riskScore: 10,
    });
    const current = snapshot({
      healthScore: 45,
      readinessScore: 35,
      architectureComplexity: 80,
      hotspotItems: [hotspot("architecture.circular-clusters", "critical")],
      criticalInsights: 1,
      riskScore: 90,
      blockers: ["Resolve critical architecture hotspots."],
      stale: true,
      ready: false,
    });

    const result = trackRepositoryEvolution(previous, current);

    assert.equal(result.trend, "REGRESSING");
    assert.equal(result.scoreDelta, -180);
    assert.ok(result.regressions.includes("Repository risk increased."));
    assert.ok(result.regressions.includes("Indexing availability regressed."));
  });

  it("reports hotspot additions", () => {
    const result = trackRepositoryEvolution(
      snapshot(),
      snapshot({
        hotspotItems: [
          hotspot("z-hotspot"),
          hotspot("a-hotspot", "medium"),
        ],
      }),
    );

    assert.deepEqual(result.newHotspots.map((item) => item.id), [
      "a-hotspot",
      "z-hotspot",
    ]);
  });

  it("reports hotspot removals", () => {
    const result = trackRepositoryEvolution(
      snapshot({
        hotspotItems: [
          hotspot("z-hotspot"),
          hotspot("a-hotspot", "medium"),
        ],
      }),
      snapshot(),
    );

    assert.deepEqual(result.resolvedHotspots.map((item) => item.id), [
      "a-hotspot",
      "z-hotspot",
    ]);
  });

  it("reports blocker resolution", () => {
    const result = trackRepositoryEvolution(
      snapshot({
        blockers: ["Resolve indexing failures.", "Review critical insight findings."],
      }),
      snapshot({
        blockers: ["Review critical insight findings."],
      }),
    );

    assert.deepEqual(result.resolvedBlockers, ["Resolve indexing failures."]);
    assert.deepEqual(result.newBlockers, []);
  });

  it("returns deterministic ordering", () => {
    const result = trackRepositoryEvolution(
      snapshot({
        blockers: ["z blocker", "a blocker"],
        hotspotItems: [hotspot("z-hotspot"), hotspot("a-hotspot")],
      }),
      snapshot({
        blockers: ["m blocker", "a blocker"],
        hotspotItems: [hotspot("m-hotspot"), hotspot("a-hotspot")],
      }),
    );

    assert.deepEqual(result.newHotspots.map((item) => item.id), ["m-hotspot"]);
    assert.deepEqual(result.resolvedHotspots.map((item) => item.id), ["z-hotspot"]);
    assert.deepEqual(result.newBlockers, ["m blocker"]);
    assert.deepEqual(result.resolvedBlockers, ["z blocker"]);
    assert.deepEqual(result.improvements, [
      "Blockers were resolved.",
      "Hotspots were resolved.",
    ]);
    assert.deepEqual(result.regressions, [
      "New blockers appeared.",
      "New hotspots appeared.",
    ]);
  });

  it("returns the same output for repeated execution", () => {
    const previous = snapshot({ healthScore: 70, riskScore: 40 });
    const current = snapshot({ healthScore: 80, riskScore: 30 });

    assert.deepEqual(
      trackRepositoryEvolution(previous, current),
      trackRepositoryEvolution(previous, current),
    );
  });

  it("does not mutate inputs", () => {
    const previous = snapshot({
      hotspotItems: [hotspot("architecture.dependency-hubs")],
      blockers: ["Resolve critical architecture hotspots."],
    });
    const current = snapshot();
    const before = JSON.stringify({ previous, current });

    const result = trackRepositoryEvolution(previous, current);
    result.resolvedHotspots[0]!.affectedModules.push("src/mutated.ts");
    result.resolvedHotspots[0]!.title = "Mutated";
    result.resolvedBlockers.push("mutated");
    result.improvements.push("mutated");

    assert.equal(JSON.stringify({ previous, current }), before);
    assert.equal(
      trackRepositoryEvolution(previous, current).resolvedHotspots[0]?.title,
      "architecture.dependency-hubs",
    );
  });
});
