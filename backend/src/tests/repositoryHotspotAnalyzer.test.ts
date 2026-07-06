import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RepositoryArchitectureAnalysis } from "../services/repository/repositoryArchitectureAnalyzer.js";
import {
  addDependency,
  addNode,
  clear,
  listEdges,
  listNodes,
} from "../services/repository/repositoryDependencyGraph.js";
import * as graph from "../services/repository/repositoryDependencyGraph.js";
import type { RepositoryHealthEngineResult } from "../services/repository/repositoryHealthEngine.js";
import type { RepositoryInsightsEngineResult } from "../services/repository/repositoryInsightsEngine.js";
import {
  analyzeRepositoryHotspots,
  type RepositoryHotspotAnalyzerInput,
} from "../services/repository/repositoryHotspotAnalyzer.js";

function architecture(
  overrides: Partial<RepositoryArchitectureAnalysis> = {},
): RepositoryArchitectureAnalysis {
  return {
    totalFiles: 3,
    totalDependencies: 2,
    rootModules: ["src/app.ts"],
    leafModules: ["src/store.ts"],
    isolatedModules: [],
    averageDependencies: 0.67,
    averageDependents: 0.67,
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
    architectureComplexityScore: 16.67,
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

function analyze(input: Partial<Omit<RepositoryHotspotAnalyzerInput, "graph">> = {}) {
  return analyzeRepositoryHotspots({
    graph,
    architecture: input.architecture ?? architecture(),
    health: input.health ?? health(),
    insights: input.insights ?? insights(),
  });
}

beforeEach(() => {
  clear();
});

describe("repository hotspot analyzer", () => {
  it("returns an empty report for a healthy empty repository", () => {
    const result = analyze({
      architecture: architecture({
        totalFiles: 0,
        totalDependencies: 0,
        rootModules: [],
        leafModules: [],
        isolatedModules: [],
        averageDependencies: 0,
        averageDependents: 0,
        mostConnectedModules: [],
        architectureComplexityScore: 0,
      }),
    });

    assert.deepEqual(result, {
      repositoryId: "acme/demo",
      hotspots: [],
      summary: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      },
    });
  });

  it("detects central dependency hubs", () => {
    const result = analyze({
      architecture: architecture({
        mostConnectedModules: [
          {
            filePath: "src/hub.ts",
            dependencyCount: 5,
            dependentCount: 4,
            totalConnections: 9,
          },
        ],
      }),
    });

    assert.deepEqual(result.hotspots.map((hotspot) => hotspot.id), [
      "architecture.dependency-hubs",
    ]);
    assert.deepEqual(result.hotspots[0]?.affectedModules, ["src/hub.ts"]);
    assert.equal(result.summary.high, 1);
  });

  it("detects circular dependency clusters", () => {
    addDependency("src/a.ts", "src/b.ts");
    addDependency("src/b.ts", "src/c.ts");
    addDependency("src/c.ts", "src/a.ts");

    const result = analyze({
      architecture: architecture({
        circularDependencyCount: 1,
        hasCycles: true,
        mostConnectedModules: [
          {
            filePath: "src/a.ts",
            dependencyCount: 1,
            dependentCount: 1,
            totalConnections: 2,
          },
        ],
      }),
    });

    assert.equal(result.hotspots[0]?.id, "architecture.circular-clusters");
    assert.equal(result.hotspots[0]?.severity, "critical");
    assert.equal(result.summary.critical, 1);
  });

  it("detects isolated modules", () => {
    const result = analyze({
      architecture: architecture({
        isolatedModules: ["src/z.ts", "src/a.ts"],
      }),
    });

    assert.equal(result.hotspots[0]?.id, "architecture.isolated-modules");
    assert.deepEqual(result.hotspots[0]?.affectedModules, [
      "src/a.ts",
      "src/z.ts",
    ]);
    assert.equal(result.summary.medium, 1);
  });

  it("detects unhealthy architectural regions", () => {
    const result = analyze({
      architecture: architecture({
        mostConnectedModules: [
          {
            filePath: "src/hot.ts",
            dependencyCount: 2,
            dependentCount: 2,
            totalConnections: 4,
          },
        ],
      }),
      health: health({
        healthy: false,
        score: 45,
        grade: "fair",
        warnings: ["Repository health needs attention."],
      }),
    });

    assert.deepEqual(result.hotspots.map((hotspot) => hotspot.id), [
      "architecture.dependency-hubs",
      "health.unhealthy-architecture",
    ]);
    assert.equal(result.hotspots[1]?.severity, "high");
  });

  it("detects high complexity modules", () => {
    const result = analyze({
      architecture: architecture({
        architectureComplexityScore: 82,
        mostConnectedModules: [
          {
            filePath: "src/complex.ts",
            dependencyCount: 3,
            dependentCount: 3,
            totalConnections: 6,
          },
        ],
      }),
    });

    assert.deepEqual(result.hotspots.map((hotspot) => hotspot.id), [
      "architecture.dependency-hubs",
      "architecture.high-complexity",
    ]);
  });

  it("detects stale architectural areas", () => {
    const result = analyze({
      health: health({
        healthy: false,
        score: 65,
        grade: "fair",
        signals: {
          indexed: true,
          ready: true,
          stale: true,
          hasRecentLifecycleActivity: true,
          cleanupSignalsAvailable: true,
        },
      }),
    });

    assert.deepEqual(result.hotspots.map((hotspot) => hotspot.id), [
      "health.unhealthy-architecture",
      "analysis.stale-architecture",
    ]);
  });

  it("detects indexing bottlenecks", () => {
    const result = analyze({
      health: health({
        healthy: false,
        score: 20,
        grade: "poor",
        signals: {
          indexed: false,
          ready: false,
          stale: false,
          hasRecentLifecycleActivity: false,
          cleanupSignalsAvailable: false,
        },
      }),
    });

    assert.deepEqual(result.hotspots.map((hotspot) => hotspot.id), [
      "analysis.indexing-bottleneck",
      "health.unhealthy-architecture",
    ]);
    assert.equal(result.summary.critical, 2);
  });

  it("detects critical dependency chains", () => {
    addDependency("src/a.ts", "src/b.ts");
    addDependency("src/b.ts", "src/c.ts");
    addDependency("src/c.ts", "src/d.ts");
    addDependency("src/d.ts", "src/e.ts");

    const result = analyze({
      architecture: architecture({
        totalFiles: 5,
        totalDependencies: 4,
        averageDependencies: 0.8,
        averageDependents: 0.8,
      }),
    });

    assert.equal(result.hotspots[0]?.id, "architecture.critical-dependency-chains");
    assert.deepEqual(result.hotspots[0]?.affectedModules, [
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]);
  });

  it("promotes critical architecture insights", () => {
    const result = analyze({
      insights: insights({
        insights: [
          {
            id: "layer-break",
            type: "architecture",
            severity: "critical",
            title: "Layer break",
            description: "Persistence leaks into controllers.",
            recommendation: "Restore layering.",
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
      }),
    });

    assert.deepEqual(result.hotspots.map((hotspot) => hotspot.id), [
      "insight.layer-break",
    ]);
    assert.deepEqual(result.hotspots[0]?.affectedModules, [
      "src/controller.ts",
    ]);
  });

  it("returns deterministic ordering", () => {
    addDependency("src/a.ts", "src/b.ts");
    addDependency("src/b.ts", "src/c.ts");
    addDependency("src/c.ts", "src/a.ts");

    const result = analyze({
      architecture: architecture({
        isolatedModules: ["src/isolated.ts"],
        circularDependencyCount: 1,
        hasCycles: true,
        architectureComplexityScore: 90,
        mostConnectedModules: [
          {
            filePath: "src/hub.ts",
            dependencyCount: 5,
            dependentCount: 4,
            totalConnections: 9,
          },
        ],
      }),
      health: health({
        healthy: false,
        score: 30,
        grade: "poor",
      }),
    });

    assert.deepEqual(result.hotspots.map((hotspot) => hotspot.id), [
      "architecture.circular-clusters",
      "health.unhealthy-architecture",
      "architecture.critical-dependency-chains",
      "architecture.dependency-hubs",
      "architecture.high-complexity",
      "architecture.isolated-modules",
    ]);
  });

  it("returns deterministic repeated output", () => {
    addDependency("src/a.ts", "src/b.ts");
    addDependency("src/b.ts", "src/c.ts");
    const input = {
      architecture: architecture({ totalDependencies: 2 }),
      health: health(),
      insights: insights(),
    };

    assert.deepEqual(analyze(input), analyze(input));
  });

  it("does not mutate inputs or graph state", () => {
    addDependency("src/app.ts", "src/service.ts");
    addNode("src/isolated.ts");
    const nodesBefore = listNodes();
    const edgesBefore = listEdges();
    const input = {
      architecture: architecture({
        isolatedModules: ["src/isolated.ts"],
        mostConnectedModules: [
          {
            filePath: "src/service.ts",
            dependencyCount: 1,
            dependentCount: 1,
            totalConnections: 2,
          },
        ],
      }),
      health: health(),
      insights: insights(),
    };
    const inputBefore = JSON.stringify(input);

    const result = analyze(input);
    result.hotspots[0]!.affectedModules.push("src/mutated.ts");
    result.hotspots[0]!.title = "Mutated";

    assert.equal(JSON.stringify(input), inputBefore);
    assert.deepEqual(listNodes(), nodesBefore);
    assert.deepEqual(listEdges(), edgesBefore);
    assert.equal(analyze(input).hotspots[0]?.title, "Isolated modules");
  });
});
