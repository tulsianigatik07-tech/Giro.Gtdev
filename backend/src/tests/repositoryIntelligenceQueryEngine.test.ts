import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RepositoryArchitectureAnalysis } from "../services/repository/repositoryArchitectureAnalyzer.js";
import type { RepositoryAiReadinessResult } from "../services/repository/repositoryAiReadinessEngine.js";
import type { RepositoryHealthEngineResult } from "../services/repository/repositoryHealthEngine.js";
import type { RepositoryHotspotReport } from "../services/repository/repositoryHotspotAnalyzer.js";
import type { RepositoryInsightsEngineResult } from "../services/repository/repositoryInsightsEngine.js";
import type { RepositoryRecommendationResult } from "../services/repository/repositoryRecommendationEngine.js";
import type { RepositoryRiskReport } from "../services/repository/repositoryRiskAnalyzer.js";
import {
  queryRepositoryIntelligence,
  type RepositoryIntelligenceQueryReport,
} from "../services/repository/repositoryIntelligenceQueryEngine.js";

function health(): RepositoryHealthEngineResult {
  return {
    repositoryId: "acme/demo",
    score: 65,
    grade: "fair",
    healthy: false,
    signals: {
      indexed: true,
      ready: true,
      stale: true,
      hasRecentLifecycleActivity: true,
      cleanupSignalsAvailable: true,
    },
    warnings: ["Repository index is stale."],
    recommendations: ["Refresh repository metadata."],
  };
}

function aiReadiness(): RepositoryAiReadinessResult {
  return {
    repositoryId: "acme/demo",
    ready: false,
    score: 60,
    level: "degraded",
    blockers: [],
    warnings: ["Repository index is stale."],
    recommendations: ["Refresh or reindex the repository."],
    signals: {
      metadataAvailable: true,
      indexed: true,
      readyForRetrieval: true,
      failed: false,
      stale: true,
      healthScore: 65,
      healthHealthy: false,
      retrievalResultsAvailable: true,
      criticalInsights: 0,
      warningInsights: 1,
    },
  };
}

function risk(): RepositoryRiskReport {
  return {
    repositoryId: "acme/demo",
    score: 55,
    level: "HIGH",
    summary: "Repository risk is high.",
    strengths: ["Repository is indexed."],
    risks: ["Central dependency hubs are present."],
    blockers: ["Resolve critical architecture hotspots."],
    signals: {
      healthy: false,
      indexed: true,
      ready: true,
      stale: true,
      healthScore: 65,
      architectureComplexityScore: 72,
      totalFiles: 4,
      totalDependencies: 3,
      circularDependencyCount: 1,
      dependencyHubCount: 1,
      criticalHotspots: 1,
      highHotspots: 1,
      mediumHotspots: 0,
      lowHotspots: 0,
      criticalInsights: 1,
      warningInsights: 1,
      failedIndexingSignals: 0,
    },
  };
}

function hotspots(): RepositoryHotspotReport {
  return {
    repositoryId: "acme/demo",
    hotspots: [
      {
        id: "architecture.dependency-hubs",
        type: "dependency_hub",
        severity: "high",
        title: "Central dependency hubs",
        description: "Hub module needs review.",
        affectedModules: ["src/hub.ts"],
        reason: "Hub has many connections.",
      },
      {
        id: "architecture.circular-clusters",
        type: "cycle_cluster",
        severity: "critical",
        title: "Circular dependency clusters",
        description: "Cycle detected.",
        affectedModules: ["src/cycle.ts"],
        reason: "Circular dependency exists.",
      },
    ],
    summary: {
      critical: 1,
      high: 1,
      medium: 0,
      low: 0,
    },
  };
}

function recommendations(): RepositoryRecommendationResult {
  return {
    repositoryId: "acme/demo",
    recommendations: [
      {
        id: "architecture.reduce-hub",
        priority: "high",
        severity: "warning",
        title: "Reduce hub coupling",
        description: "Hub module should be split.",
        reason: "Hub has too many dependencies.",
        category: "insights",
        action: "Split src/hub.ts.",
      },
    ],
    summary: {
      total: 1,
      critical: 0,
      warnings: 1,
      informational: 0,
    },
  };
}

function insights(): RepositoryInsightsEngineResult {
  return {
    repositoryId: "acme/demo",
    insights: [
      {
        id: "architecture.layer-break",
        type: "architecture",
        severity: "critical",
        title: "Layer break",
        description: "Controller imports persistence directly.",
        recommendation: "Route through service.",
        signals: { module: "src/controller.ts" },
      },
    ],
    summary: {
      total: 1,
      critical: 1,
      warnings: 0,
      successes: 0,
      informational: 0,
    },
  };
}

function architecture(): RepositoryArchitectureAnalysis {
  return {
    totalFiles: 4,
    totalDependencies: 3,
    rootModules: ["src/app.ts"],
    leafModules: ["src/store.ts"],
    isolatedModules: [],
    averageDependencies: 0.75,
    averageDependents: 0.75,
    mostConnectedModules: [
      {
        filePath: "src/hub.ts",
        dependencyCount: 4,
        dependentCount: 4,
        totalConnections: 8,
      },
    ],
    circularDependencyCount: 1,
    hasCycles: true,
    architectureComplexityScore: 72,
  };
}

function report(): RepositoryIntelligenceQueryReport {
  return {
    repositoryId: "acme/demo",
    health: health(),
    aiReadiness: aiReadiness(),
    risk: risk(),
    hotspots: hotspots(),
    recommendations: recommendations(),
    insights: insights(),
    architecture: architecture(),
  };
}

describe("repository intelligence query engine", () => {
  it("returns all matches for an empty query", () => {
    const result = queryRepositoryIntelligence({ report: report(), filters: {} });

    assert.equal(result.repositoryId, "acme/demo");
    assert.equal(result.totalMatches, 8);
    assert.deepEqual(result.matches.map((match) => match.id), [
      "health.status",
      "aiReadiness.status",
      "risk.status",
      "hotspot.architecture.circular-clusters",
      "hotspot.architecture.dependency-hubs",
      "recommendation.architecture.reduce-hub",
      "insight.architecture.layer-break",
      "architecture.summary",
    ]);
  });

  it("filters by severity", () => {
    const result = queryRepositoryIntelligence({
      report: report(),
      filters: { severity: "critical" },
    });

    assert.deepEqual(result.matches.map((match) => match.id), [
      "hotspot.architecture.circular-clusters",
      "insight.architecture.layer-break",
    ]);
  });

  it("filters by category", () => {
    const result = queryRepositoryIntelligence({
      report: report(),
      filters: { category: "hotspots" },
    });

    assert.deepEqual(result.matches.map((match) => match.id), [
      "hotspot.architecture.circular-clusters",
      "hotspot.architecture.dependency-hubs",
    ]);
    assert.equal(result.groupedResults.hotspots.length, 2);
  });

  it("filters by module", () => {
    const result = queryRepositoryIntelligence({
      report: report(),
      filters: { module: "src/hub.ts" },
    });

    assert.deepEqual(result.matches.map((match) => match.id), [
      "hotspot.architecture.dependency-hubs",
      "architecture.summary",
    ]);
  });

  it("applies multiple filters", () => {
    const result = queryRepositoryIntelligence({
      report: report(),
      filters: {
        category: "hotspots",
        severity: "high",
        module: "hub",
      },
    });

    assert.deepEqual(result.matches.map((match) => match.id), [
      "hotspot.architecture.dependency-hubs",
    ]);
  });

  it("filters risk, readiness, health, blocker, and recommendation text", () => {
    assert.deepEqual(
      queryRepositoryIntelligence({ report: report(), filters: { risk: "HIGH" } }).matches.map(
        (match) => match.id,
      ),
      ["risk.status"],
    );
    assert.deepEqual(
      queryRepositoryIntelligence({ report: report(), filters: { readiness: "degraded" } }).matches.map(
        (match) => match.id,
      ),
      ["aiReadiness.status"],
    );
    assert.deepEqual(
      queryRepositoryIntelligence({ report: report(), filters: { health: "stale" } }).matches.map(
        (match) => match.id,
      ),
      ["health.status"],
    );
    assert.deepEqual(
      queryRepositoryIntelligence({ report: report(), filters: { blocker: "critical architecture" } }).matches.map(
        (match) => match.id,
      ),
      ["risk.status"],
    );
    assert.deepEqual(
      queryRepositoryIntelligence({ report: report(), filters: { recommendation: "split" } }).matches.map(
        (match) => match.id,
      ),
      ["recommendation.architecture.reduce-hub"],
    );
  });

  it("returns deterministic ordering", () => {
    const result = queryRepositoryIntelligence({
      report: report(),
      filters: { severity: ["warning", "critical", "high"] },
    });

    assert.deepEqual(result.matches.map((match) => match.id), [
      "health.status",
      "aiReadiness.status",
      "risk.status",
      "hotspot.architecture.circular-clusters",
      "hotspot.architecture.dependency-hubs",
      "recommendation.architecture.reduce-hub",
      "insight.architecture.layer-break",
      "architecture.summary",
    ]);
  });

  it("returns the same output for repeated execution", () => {
    const input = { report: report(), filters: { module: "src/hub.ts" } };

    assert.deepEqual(
      queryRepositoryIntelligence(input),
      queryRepositoryIntelligence(input),
    );
  });

  it("does not mutate inputs", () => {
    const input = { report: report(), filters: { category: "hotspots" } };
    const before = JSON.stringify(input);

    const result = queryRepositoryIntelligence(input);
    result.matches[0]!.modules.push("src/mutated.ts");
    result.groupedResults.hotspots[0]!.title = "Mutated";

    assert.equal(JSON.stringify(input), before);
    assert.notEqual(
      queryRepositoryIntelligence(input).matches[0]?.modules.includes("src/mutated.ts"),
      true,
    );
  });
});
