import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { RepositoryArchitectureAnalysis } from "../services/repository/repositoryArchitectureAnalyzer.js";
import type { RepositoryHealthEngineResult } from "../services/repository/repositoryHealthEngine.js";
import type { RepositoryInsightsEngineResult } from "../services/repository/repositoryInsightsEngine.js";
import {
  buildRepositoryRefactoringReport,
  type RepositoryRefactoringInput,
} from "../services/repository/repositoryRefactoringEngine.js";

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

function report(input: Partial<RepositoryRefactoringInput> = {}) {
  return buildRepositoryRefactoringReport({
    architecture: input.architecture ?? architecture(),
    health: input.health ?? health(),
    insights: input.insights ?? insights(),
  });
}

describe("repository refactoring engine", () => {
  it("returns no opportunities for an empty healthy repository", () => {
    const result = report({
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

    assert.deepEqual(result.opportunities, []);
    assert.deepEqual(result.summary, {
      total: 0,
      critical: 0,
      warnings: 0,
      informational: 0,
      impactedModuleCount: 0,
    });
  });

  it("returns no opportunities for healthy architecture", () => {
    assert.deepEqual(report().opportunities, []);
  });

  it("detects isolated modules", () => {
    const result = report({
      architecture: architecture({
        isolatedModules: ["src/unused.ts", "src/legacy.ts"],
      }),
    });

    assert.deepEqual(result.opportunities.map((item) => item.id), [
      "architecture.isolated-modules",
    ]);
    assert.deepEqual(result.opportunities[0]?.impactedModules, [
      "src/legacy.ts",
      "src/unused.ts",
    ]);
  });

  it("detects circular dependencies", () => {
    const result = report({
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

    assert.equal(result.opportunities[0]?.id, "architecture.circular-dependencies");
    assert.equal(result.opportunities[0]?.severity, "critical");
    assert.equal(result.summary.critical, 1);
  });

  it("detects dependency hubs and excessive coupling", () => {
    const result = report({
      architecture: architecture({
        averageDependencies: 3.5,
        averageDependents: 3.5,
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

    assert.deepEqual(result.opportunities.map((item) => item.id), [
      "architecture.dependency-hubs",
      "architecture.excessive-coupling",
    ]);
    assert.deepEqual(
      result.opportunities.map((item) => item.impactedModules),
      [["src/hub.ts"], ["src/hub.ts"]],
    );
  });

  it("detects stale repositories", () => {
    const result = report({
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
        warnings: ["Repository index is stale."],
        recommendations: ["Refresh or reindex the repository to restore freshness."],
      }),
    });

    assert.deepEqual(result.opportunities.map((item) => item.id), [
      "analysis.stale-architecture",
      "architecture.unhealthy-repository",
    ]);
  });

  it("detects indexing blockers affecting analysis", () => {
    const result = report({
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
        warnings: ["Repository is not indexed."],
        recommendations: ["Index the repository before relying on dashboard insights."],
      }),
    });

    assert.deepEqual(result.opportunities.map((item) => item.id), [
      "analysis.indexing-blocked",
      "architecture.unhealthy-repository",
    ]);
    assert.equal(result.summary.critical, 2);
  });

  it("promotes architecture insights deterministically", () => {
    const result = report({
      insights: insights({
        insights: [
          {
            id: "layer-violation",
            type: "architecture",
            severity: "warning",
            title: "Layer violation",
            description: "Controller imports persistence directly.",
            recommendation: "Route through a service boundary.",
            signals: { module: "src/controller.ts" },
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
    });

    assert.deepEqual(result.opportunities.map((item) => item.id), [
      "insight.layer-violation",
    ]);
    assert.deepEqual(result.opportunities[0]?.impactedModules, [
      "src/controller.ts",
    ]);
  });

  it("returns deterministic ordering", () => {
    const result = report({
      architecture: architecture({
        isolatedModules: ["src/z.ts"],
        circularDependencyCount: 1,
        hasCycles: true,
        averageDependencies: 4,
        averageDependents: 4,
        mostConnectedModules: [
          {
            filePath: "src/hub.ts",
            dependencyCount: 6,
            dependentCount: 2,
            totalConnections: 8,
          },
        ],
      }),
      health: health({
        healthy: false,
        score: 30,
        grade: "poor",
        signals: {
          indexed: true,
          ready: true,
          stale: true,
          hasRecentLifecycleActivity: true,
          cleanupSignalsAvailable: true,
        },
      }),
    });

    assert.deepEqual(result.opportunities.map((item) => item.id), [
      "architecture.circular-dependencies",
      "architecture.unhealthy-repository",
      "analysis.stale-architecture",
      "architecture.dependency-hubs",
      "architecture.excessive-coupling",
      "architecture.isolated-modules",
    ]);
  });

  it("returns the same output for repeated execution", () => {
    const input = {
      architecture: architecture({ isolatedModules: ["src/a.ts"] }),
      health: health(),
      insights: insights(),
    };

    assert.deepEqual(
      buildRepositoryRefactoringReport(input),
      buildRepositoryRefactoringReport(input),
    );
  });

  it("does not mutate inputs", () => {
    const input = {
      architecture: architecture({
        isolatedModules: ["src/unused.ts"],
        mostConnectedModules: [
          {
            filePath: "src/hub.ts",
            dependencyCount: 4,
            dependentCount: 4,
            totalConnections: 8,
          },
        ],
      }),
      health: health({
        warnings: ["Repository health warning."],
        recommendations: ["Review repository health."],
      }),
      insights: insights(),
    };
    const before = JSON.stringify(input);

    const result = buildRepositoryRefactoringReport(input);
    result.opportunities[0]!.impactedModules.push("src/mutated.ts");
    result.opportunities[0]!.title = "Mutated";

    assert.equal(JSON.stringify(input), before);
    assert.equal(
      buildRepositoryRefactoringReport(input).opportunities[0]?.title,
      "Split oversized dependency hubs",
    );
  });
});
