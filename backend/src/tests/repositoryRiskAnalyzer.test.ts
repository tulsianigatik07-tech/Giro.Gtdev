import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RepositoryArchitectureAnalysis } from "../services/repository/repositoryArchitectureAnalyzer.js";
import type { RepositoryHealthEngineResult } from "../services/repository/repositoryHealthEngine.js";
import type { RepositoryHotspotReport } from "../services/repository/repositoryHotspotAnalyzer.js";
import type { RepositoryInsightsEngineResult } from "../services/repository/repositoryInsightsEngine.js";
import {
  analyzeRepositoryRisk,
  type RepositoryRiskInput,
} from "../services/repository/repositoryRiskAnalyzer.js";

function architecture(
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
    mostConnectedModules: [
      {
        filePath: "src/service.ts",
        dependencyCount: 1,
        dependentCount: 1,
        totalConnections: 2,
      },
    ],
    circularDependencyCount: 0,
    hasCycles: false,
    architectureComplexityScore: 18,
    ...overrides,
  };
}

function health(
  overrides: Partial<RepositoryHealthEngineResult> = {},
): RepositoryHealthEngineResult {
  return {
    repositoryId: "acme/demo",
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

function hotspots(overrides: Partial<RepositoryHotspotReport> = {}): RepositoryHotspotReport {
  return {
    repositoryId: "acme/demo",
    hotspots: [],
    summary: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    },
    ...overrides,
  };
}

function insights(
  overrides: Partial<RepositoryInsightsEngineResult> = {},
): RepositoryInsightsEngineResult {
  return {
    repositoryId: "acme/demo",
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

function analyze(input: Partial<RepositoryRiskInput> = {}) {
  return analyzeRepositoryRisk({
    health: input.health ?? health(),
    architecture: input.architecture ?? architecture(),
    hotspots: input.hotspots ?? hotspots(),
    insights: input.insights ?? insights(),
  });
}

describe("repository risk analyzer", () => {
  it("reports low risk for a healthy repository", () => {
    const result = analyze();

    assert.equal(result.repositoryId, "acme/demo");
    assert.equal(result.level, "LOW");
    assert.equal(result.score, 6);
    assert.deepEqual(result.risks, []);
    assert.deepEqual(result.blockers, []);
    assert.ok(result.strengths.includes("Repository is indexed."));
  });

  it("reports medium risk", () => {
    const result = analyze({
      health: health({
        score: 72,
        grade: "good",
        healthy: true,
        signals: {
          indexed: true,
          ready: true,
          stale: true,
          hasRecentLifecycleActivity: true,
          cleanupSignalsAvailable: true,
        },
      }),
      architecture: architecture({
        architectureComplexityScore: 42,
      }),
      hotspots: hotspots({
        hotspots: [
          {
            id: "architecture.isolated-modules",
            type: "isolated_module",
            severity: "medium",
            title: "Isolated modules",
            description: "Standalone modules need review.",
            affectedModules: ["src/legacy.ts"],
            reason: "1 isolated module was detected.",
          },
        ],
        summary: {
          critical: 0,
          high: 0,
          medium: 1,
          low: 0,
        },
      }),
    });

    assert.equal(result.level, "MEDIUM");
    assert.equal(result.score, 33);
    assert.ok(result.risks.includes("Repository index is stale."));
  });

  it("reports high risk", () => {
    const result = analyze({
      health: health({
        score: 55,
        grade: "fair",
        healthy: false,
        warnings: ["Repository health needs attention."],
      }),
      architecture: architecture({
        architectureComplexityScore: 72,
        mostConnectedModules: [
          {
            filePath: "src/hub.ts",
            dependencyCount: 4,
            dependentCount: 4,
            totalConnections: 8,
          },
        ],
      }),
      hotspots: hotspots({
        hotspots: [
          {
            id: "architecture.dependency-hubs",
            type: "dependency_hub",
            severity: "high",
            title: "Dependency hub",
            description: "Hub module.",
            affectedModules: ["src/hub.ts"],
            reason: "Hub detected.",
          },
        ],
        summary: {
          critical: 0,
          high: 1,
          medium: 0,
          low: 0,
        },
      }),
    });

    assert.equal(result.level, "HIGH");
    assert.equal(result.score, 63);
    assert.ok(result.risks.includes("Architecture complexity is high."));
    assert.ok(result.risks.includes("Central dependency hubs are present."));
  });

  it("reports critical risk", () => {
    const result = analyze({
      health: health({
        score: 18,
        grade: "poor",
        healthy: false,
        signals: {
          indexed: false,
          ready: false,
          stale: true,
          hasRecentLifecycleActivity: false,
          cleanupSignalsAvailable: false,
        },
        warnings: ["Repository indexing failed."],
      }),
      architecture: architecture({
        circularDependencyCount: 2,
        hasCycles: true,
        architectureComplexityScore: 90,
        mostConnectedModules: [
          {
            filePath: "src/cycle.ts",
            dependencyCount: 5,
            dependentCount: 5,
            totalConnections: 10,
          },
        ],
      }),
      hotspots: hotspots({
        hotspots: [
          {
            id: "architecture.circular-clusters",
            type: "cycle_cluster",
            severity: "critical",
            title: "Circular clusters",
            description: "Cycles.",
            affectedModules: ["src/cycle.ts"],
            reason: "Cycle detected.",
          },
        ],
        summary: {
          critical: 1,
          high: 1,
          medium: 0,
          low: 0,
        },
      }),
      insights: insights({
        insights: [
          {
            id: "indexing.failed",
            type: "indexing",
            severity: "critical",
            title: "Indexing failed",
            description: "Indexing failed.",
            signals: {},
          },
        ],
        summary: {
          total: 1,
          critical: 1,
          warnings: 0,
          successes: 0,
          informational: 0,
        },
      }),
    });

    assert.equal(result.level, "CRITICAL");
    assert.equal(result.score, 100);
    assert.deepEqual(result.blockers, [
      "Index the repository before relying on analysis.",
      "Resolve critical architecture hotspots.",
      "Resolve indexing failures.",
      "Resolve readiness blockers before using AI analysis.",
      "Review critical insight findings.",
    ]);
  });

  it("returns deterministic ordering", () => {
    const result = analyze({
      health: health({
        score: 40,
        grade: "fair",
        healthy: false,
        signals: {
          indexed: true,
          ready: false,
          stale: true,
          hasRecentLifecycleActivity: true,
          cleanupSignalsAvailable: true,
        },
        warnings: ["Repository indexing failed.", "Repository is not ready."],
      }),
      architecture: architecture({
        circularDependencyCount: 1,
        architectureComplexityScore: 80,
        mostConnectedModules: [
          {
            filePath: "src/hub.ts",
            dependencyCount: 4,
            dependentCount: 4,
            totalConnections: 8,
          },
        ],
      }),
      hotspots: hotspots({
        summary: {
          critical: 1,
          high: 1,
          medium: 1,
          low: 1,
        },
      }),
      insights: insights({
        insights: [
          {
            id: "z-warning",
            type: "architecture",
            severity: "warning",
            title: "Warning",
            description: "Warning.",
            signals: {},
          },
          {
            id: "a-critical",
            type: "architecture",
            severity: "critical",
            title: "Critical",
            description: "Critical.",
            signals: {},
          },
        ],
      }),
    });

    assert.deepEqual(result.risks, [
      "Architecture complexity is high.",
      "Central dependency hubs are present.",
      "Circular dependency groups are present.",
      "Critical hotspot signals are present.",
      "Critical insight signals are present.",
      "High-severity hotspot signals are present.",
      "Indexing failure signals are present.",
      "Repository health is below the healthy threshold.",
      "Repository index is stale.",
      "Repository is not ready for AI-assisted analysis.",
      "Warning insight signals are present.",
    ]);
  });

  it("returns the same output for repeated execution", () => {
    const input = {
      health: health({ score: 72 }),
      architecture: architecture({ architectureComplexityScore: 42 }),
      hotspots: hotspots({ summary: { critical: 0, high: 0, medium: 1, low: 0 } }),
      insights: insights(),
    };

    assert.deepEqual(analyzeRepositoryRisk(input), analyzeRepositoryRisk(input));
  });

  it("does not mutate inputs", () => {
    const input = {
      health: health({
        warnings: ["Repository health warning."],
        recommendations: ["Review repository health."],
      }),
      architecture: architecture({
        mostConnectedModules: [
          {
            filePath: "src/hub.ts",
            dependencyCount: 4,
            dependentCount: 4,
            totalConnections: 8,
          },
        ],
      }),
      hotspots: hotspots({
        hotspots: [
          {
            id: "architecture.dependency-hubs",
            type: "dependency_hub",
            severity: "high",
            title: "Dependency hub",
            description: "Hub module.",
            affectedModules: ["src/hub.ts"],
            reason: "Hub detected.",
          },
        ],
        summary: {
          critical: 0,
          high: 1,
          medium: 0,
          low: 0,
        },
      }),
      insights: insights({
        insights: [
          {
            id: "architecture.warning",
            type: "architecture",
            severity: "warning",
            title: "Architecture warning",
            description: "Warning.",
            signals: {},
          },
        ],
      }),
    };
    const before = JSON.stringify(input);

    const result = analyzeRepositoryRisk(input);
    result.risks.push("mutated");
    result.strengths.push("mutated");
    result.blockers.push("mutated");
    result.signals.healthScore = -1;

    assert.equal(JSON.stringify(input), before);
    assert.notEqual(analyzeRepositoryRisk(input).signals.healthScore, -1);
  });
});
