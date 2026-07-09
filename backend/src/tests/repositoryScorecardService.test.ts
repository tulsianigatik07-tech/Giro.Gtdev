import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { RepositoryComparisonReport } from "../services/repository/repositoryComparisonEngine.js";
import type { RepositoryHotspotReport } from "../services/repository/repositoryHotspotAnalyzer.js";
import type { RepositoryIntelligenceReport } from "../services/repository/repositoryIntelligenceReport.js";
import type { RepositoryRecommendationResult } from "../services/repository/repositoryRecommendationEngine.js";
import type { RepositoryRiskReport } from "../services/repository/repositoryRiskAnalyzer.js";
import { buildRepositoryScorecard } from "../services/repository/repositoryScorecardService.js";

function report(input: {
  healthScore?: number;
  healthGrade?: RepositoryIntelligenceReport["health"]["grade"];
  healthy?: boolean;
  readinessScore?: number;
  readinessLevel?: RepositoryIntelligenceReport["aiReadiness"]["level"];
  blockers?: string[];
  warnings?: string[];
  strengths?: string[];
  risks?: string[];
} = {}): RepositoryIntelligenceReport {
  const readinessLevel = input.readinessLevel ?? "ready";
  const blockers = input.blockers ?? [];
  const warnings = input.warnings ?? [];

  return {
    repositoryId: "acme/demo",
    overview: {
      score: input.healthScore ?? 92,
      health: input.healthGrade ?? "excellent",
      readiness: readinessLevel,
      indexed: true,
      stale: false,
      recommendationCount: 0,
    },
    dashboard: {} as never,
    health: {
      repositoryId: "acme/demo",
      score: input.healthScore ?? 92,
      grade: input.healthGrade ?? "excellent",
      healthy: input.healthy ?? true,
      signals: {
        indexed: true,
        ready: true,
        stale: false,
        hasRecentLifecycleActivity: true,
        cleanupSignalsAvailable: true,
      },
      warnings,
      recommendations: [],
    },
    aiReadiness: {
      repositoryId: "acme/demo",
      ready: readinessLevel === "ready",
      score: input.readinessScore ?? 92,
      level: readinessLevel,
      blockers,
      warnings,
      recommendations: [],
      signals: {} as never,
    },
    insights: {} as never,
    recommendations: {} as never,
    timeline: [],
    summary: {
      status: readinessLevel === "blocked" ? "blocked" : "healthy",
      headline: "Repository summary",
      explanation: "Repository explanation",
      strengths: input.strengths ?? ["Repository is indexed."],
      risks: input.risks ?? [],
      nextActions: [],
    },
  };
}

function risk(input: {
  score?: number;
  level?: RepositoryRiskReport["level"];
  blockers?: string[];
  risks?: string[];
  strengths?: string[];
} = {}): RepositoryRiskReport {
  return {
    repositoryId: "acme/demo",
    score: input.score ?? 8,
    level: input.level ?? "LOW",
    summary: `Repository risk is ${input.level ?? "LOW"}.`,
    strengths: input.strengths ?? ["Repository index is fresh."],
    risks: input.risks ?? [],
    blockers: input.blockers ?? [],
    signals: {} as never,
  };
}

function hotspots(ids: string[] = []): RepositoryHotspotReport {
  return {
    repositoryId: "acme/demo",
    hotspots: ids.map((id) => ({
      id,
      type: "dependency_hub",
      severity: id.includes("critical") ? "critical" : "high",
      title: id,
      description: `${id} description`,
      affectedModules: [],
      reason: `${id} reason`,
    })),
    summary: {
      critical: ids.filter((id) => id.includes("critical")).length,
      high: ids.filter((id) => !id.includes("critical")).length,
      medium: 0,
      low: 0,
    },
  };
}

function recommendations(
  items: {
    id: string;
    priority: RepositoryRecommendationResult["recommendations"][number]["priority"];
    severity: RepositoryRecommendationResult["recommendations"][number]["severity"];
    action: string;
  }[] = [],
): RepositoryRecommendationResult {
  return {
    repositoryId: "acme/demo",
    recommendations: items.map((item) => ({
      id: item.id,
      priority: item.priority,
      severity: item.severity,
      title: item.id,
      description: item.id,
      reason: item.id,
      category: "health",
      action: item.action,
    })),
    summary: {
      total: items.length,
      critical: items.filter((item) => item.severity === "critical").length,
      warnings: items.filter((item) => item.severity === "warning").length,
      informational: items.filter((item) => item.severity === "info").length,
    },
  };
}

function comparison(trend: RepositoryComparisonReport["trend"]): RepositoryComparisonReport {
  return {
    repositoryId: "acme/demo",
    beforeSnapshotId: "acme/demo#1",
    afterSnapshotId: "acme/demo#2",
    health: { before: 80, after: 85, delta: 5, trend },
    aiReadiness: { before: 80, after: 85, delta: 5, trend },
    risk: { before: 20, after: 15, delta: -5, trend },
    hotspotChanges: { added: [], removed: [], unchanged: [] },
    blockerChanges: { added: [], removed: [], unchanged: [] },
    recommendationChanges: { added: [], removed: [], unchanged: [] },
    summary: { improvements: [], regressions: [], stable: [] },
    trend,
  };
}

function input(overrides: Partial<Parameters<typeof buildRepositoryScorecard>[0]> = {}) {
  return {
    report: report(),
    risk: risk(),
    hotspots: hotspots(),
    recommendations: recommendations(),
    ...overrides,
  };
}

beforeEach(() => {
  // Fixtures are created per test; this makes intentional isolation explicit.
});

test("excellent healthy repository produces excellent scorecard", () => {
  const scorecard = buildRepositoryScorecard(input());

  assert.equal(scorecard.verdict, "EXCELLENT");
  assert.ok(scorecard.overallScore >= 90);
  assert.ok(scorecard.badges.includes("AI_READY"));
  assert.ok(scorecard.badges.includes("LOW_RISK"));
});

test("good repository produces good verdict", () => {
  const scorecard = buildRepositoryScorecard(input({
    report: report({
      healthScore: 82,
      healthGrade: "good",
      readinessScore: 82,
    }),
    risk: risk({ score: 18, level: "LOW" }),
  }));

  assert.equal(scorecard.verdict, "GOOD");
});

test("blocked repository is forced blocked by blockers", () => {
  const scorecard = buildRepositoryScorecard(input({
    report: report({
      healthScore: 88,
      readinessScore: 20,
      readinessLevel: "blocked",
      blockers: ["Repository is not indexed."],
    }),
    risk: risk({ score: 85, level: "CRITICAL", blockers: ["Resolve indexing failures."] }),
    recommendations: recommendations([
      {
        id: "indexing.run-indexing",
        priority: "critical",
        severity: "critical",
        action: "Run indexing.",
      },
    ]),
  }));

  assert.equal(scorecard.verdict, "BLOCKED");
  assert.deepEqual(scorecard.blockers, [
    "Repository is not indexed.",
    "Resolve indexing failures.",
  ]);
});

test("degraded repository needs attention", () => {
  const scorecard = buildRepositoryScorecard(input({
    report: report({
      healthScore: 68,
      healthGrade: "fair",
      healthy: false,
      readinessScore: 62,
      readinessLevel: "degraded",
      warnings: ["Repository health score is below threshold."],
    }),
    risk: risk({ score: 35, level: "MEDIUM", risks: ["Architecture complexity is elevated."] }),
  }));

  assert.equal(scorecard.verdict, "NEEDS_ATTENTION");
  assert.ok(scorecard.weaknesses.includes("Architecture complexity is elevated."));
});

test("regressing comparison reduces momentum", () => {
  const scorecard = buildRepositoryScorecard(input({
    comparison: comparison("REGRESSING"),
  }));

  assert.equal(scorecard.sections.momentum.status, "REGRESSING");
  assert.equal(scorecard.sections.momentum.score, 25);
  assert.ok(scorecard.badges.includes("MOMENTUM_DOWN"));
  assert.ok(scorecard.weaknesses.includes("Repository momentum is regressing."));
});

test("improving comparison improves momentum", () => {
  const scorecard = buildRepositoryScorecard(input({
    comparison: comparison("IMPROVING"),
  }));

  assert.equal(scorecard.sections.momentum.status, "IMPROVING");
  assert.equal(scorecard.sections.momentum.score, 80);
  assert.ok(scorecard.badges.includes("MOMENTUM_UP"));
  assert.ok(scorecard.strengths.includes("Repository momentum is improving."));
});

test("top actions are derived from recommendations in deterministic priority order", () => {
  const scorecard = buildRepositoryScorecard(input({
    recommendations: recommendations([
      {
        id: "z-low",
        priority: "low",
        severity: "info",
        action: "Run cleanup.",
      },
      {
        id: "a-critical",
        priority: "critical",
        severity: "critical",
        action: "Resolve blocker.",
      },
      {
        id: "b-high",
        priority: "high",
        severity: "warning",
        action: "Review health.",
      },
    ]),
  }));

  assert.deepEqual(scorecard.topActions, [
    "Resolve blocker.",
    "Review health.",
    "Run cleanup.",
  ]);
});

test("strengths weaknesses and badges use deterministic ordering", () => {
  const scorecard = buildRepositoryScorecard(input({
    report: report({
      strengths: ["z strength", "a strength"],
      risks: ["z risk", "a risk"],
    }),
    risk: risk({
      strengths: ["m strength"],
      risks: ["m risk"],
    }),
    hotspots: hotspots(["z-hotspot", "a-hotspot"]),
  }));

  assert.deepEqual(scorecard.strengths, [
    "a strength",
    "Health score is in a healthy range.",
    "m strength",
    "Repository is ready for AI workflows.",
    "z strength",
  ]);
  assert.deepEqual(scorecard.weaknesses, [
    "a risk",
    "a-hotspot",
    "m risk",
    "z risk",
    "z-hotspot",
  ]);
  assert.deepEqual(scorecard.badges, [
    "AI_READY",
    "EXCELLENT",
    "HEALTHY",
    "LOW_RISK",
  ]);
});

test("repeated execution returns stable isolated output", () => {
  const scorecardInput = input({
    comparison: comparison("IMPROVING"),
  });

  const first = buildRepositoryScorecard(scorecardInput);
  const second = buildRepositoryScorecard(scorecardInput);

  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.notEqual(first.sections, second.sections);
});

test("input immutability is preserved and output is immutable", () => {
  const scorecardInput = input({
    report: report({ strengths: ["safe"] }),
  });
  const before = structuredClone(scorecardInput);

  const scorecard = buildRepositoryScorecard(scorecardInput);

  assert.deepEqual(scorecardInput, before);
  assert.equal(Object.isFrozen(scorecard), true);
  assert.equal(Object.isFrozen(scorecard.sections.health), true);
  assert.equal(Object.isFrozen(scorecard.topActions), true);
  assert.throws(() => {
    (scorecard.strengths as string[]).push("mutated");
  }, TypeError);
});
