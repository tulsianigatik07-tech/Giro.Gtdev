import test from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryHealthSummary } from "../services/repository/repositoryHealthSummary.js";
import type { RepositoryOverview } from "../services/repository/repositoryOverview.js";

function overview(overrides?: {
  structure?: Partial<RepositoryOverview["structure"]>;
  architecture?: Partial<RepositoryOverview["architecture"]>;
}): RepositoryOverview {
  return {
    structure: {
      totalFiles: 5,
      totalChunks: 10,
      totalSymbols: 20,
      totalGraphNodes: 5,
      totalGraphEdges: 5,
      summaryAvailable: true,
      repositoryScale: "small",
      ...overrides?.structure,
    },
    architecture: {
      totalFiles: 5,
      totalDependencies: 5,
      averageDependenciesPerFile: 1,
      isolatedFiles: 0,
      connectedFiles: 5,
      architectureComplexity: "low",
      ...overrides?.architecture,
    },
  };
}

test("1. excellent-health repo (score >= 90)", () => {
  // low complexity, density 1, coverage 4 -> no penalties -> 100
  const h = buildRepositoryHealthSummary(overview());
  assert.equal(h.healthScore, 100);
  assert.equal(h.healthCategory, "excellent");
});

test("2. good-health repo", () => {
  // complexity medium (-10) + coverage 2 (<3, -10) -> 80
  const h = buildRepositoryHealthSummary(
    overview({
      structure: { totalFiles: 5, totalSymbols: 10 }, // coverage 2
      architecture: { totalDependencies: 5, architectureComplexity: "medium" }, // density 1
    }),
  );
  assert.equal(h.healthScore, 80);
  assert.equal(h.healthCategory, "good");
});

test("3. fair-health repo", () => {
  // high complexity (-25) + coverage 0.4 (<1, -25) -> 50
  const h = buildRepositoryHealthSummary(
    overview({
      structure: { totalFiles: 5, totalSymbols: 2 }, // coverage 0.4
      architecture: { totalDependencies: 5, architectureComplexity: "high" }, // density 1
    }),
  );
  assert.equal(h.healthScore, 50);
  assert.equal(h.healthCategory, "fair");
});

test("4. poor-health repo (25)", () => {
  // high (-25) + density 12 (>10, -25) + coverage 0.4 (<1, -25) -> 25
  const h = buildRepositoryHealthSummary(
    overview({
      structure: { totalFiles: 5, totalSymbols: 2 }, // coverage 0.4
      architecture: { totalDependencies: 60, architectureComplexity: "high" }, // density 12
    }),
  );
  assert.equal(h.healthScore, 25);
  assert.equal(h.healthCategory, "poor");
});

test("5. scale propagation for small/medium/large", () => {
  for (const scale of ["small", "medium", "large"] as const) {
    const h = buildRepositoryHealthSummary(overview({ structure: { repositoryScale: scale } }));
    assert.equal(h.scale, scale);
  }
});

test("6. complexity propagation for low/medium/high", () => {
  for (const complexity of ["low", "medium", "high"] as const) {
    const h = buildRepositoryHealthSummary(overview({ architecture: { architectureComplexity: complexity } }));
    assert.equal(h.complexity, complexity);
  }
});

test("7. fileCoverage calculation (10 symbols / 5 files -> 2)", () => {
  const h = buildRepositoryHealthSummary(overview({ structure: { totalFiles: 5, totalSymbols: 10 } }));
  assert.equal(h.fileCoverage, 2);
});

test("8. dependencyDensity calculation (15 deps / 5 files -> 3)", () => {
  const h = buildRepositoryHealthSummary(
    overview({ structure: { totalFiles: 5 }, architecture: { totalDependencies: 15 } }),
  );
  assert.equal(h.dependencyDensity, 3);
});

test("9. zero-file repo -> coverage 0, density 0, score 75 good, no NaN", () => {
  const h = buildRepositoryHealthSummary(
    overview({
      structure: { totalFiles: 0, totalSymbols: 0 },
      architecture: { totalFiles: 0, totalDependencies: 0, architectureComplexity: "low" },
    }),
  );
  assert.equal(h.fileCoverage, 0);
  assert.equal(h.dependencyDensity, 0);
  assert.ok(Number.isFinite(h.fileCoverage));
  assert.ok(Number.isFinite(h.dependencyDensity));
  assert.equal(h.healthScore, 75);
  assert.equal(h.healthCategory, "good");
});

test("10. score clamping: always within [0, 100]", () => {
  const configs: RepositoryOverview[] = [
    overview(),
    overview({ structure: { totalSymbols: 2 }, architecture: { totalDependencies: 60, architectureComplexity: "high" } }),
    overview({ structure: { totalFiles: 0, totalSymbols: 0 }, architecture: { totalFiles: 0, totalDependencies: 0 } }),
  ];
  for (const o of configs) {
    const h = buildRepositoryHealthSummary(o);
    assert.ok(h.healthScore >= 0 && h.healthScore <= 100);
  }
});

test("11. category boundaries: 90 excellent, 70 good, 50 fair, <50 poor", () => {
  // 90: complexity medium (-10) only
  const at90 = buildRepositoryHealthSummary(
    overview({ structure: { totalSymbols: 20 }, architecture: { totalDependencies: 5, architectureComplexity: "medium" } }),
  );
  assert.equal(at90.healthScore, 90);
  assert.equal(at90.healthCategory, "excellent");

  // 70: medium (-10) + density 6 (>5, -10) + coverage 2 (<3, -10)
  const at70 = buildRepositoryHealthSummary(
    overview({ structure: { totalFiles: 5, totalSymbols: 10 }, architecture: { totalDependencies: 30, architectureComplexity: "medium" } }),
  );
  assert.equal(at70.healthScore, 70);
  assert.equal(at70.healthCategory, "good");

  // 50: high (-25) + density 12 (>10, -25), coverage 4 (>=3, 0)
  const at50 = buildRepositoryHealthSummary(
    overview({ structure: { totalFiles: 5, totalSymbols: 20 }, architecture: { totalDependencies: 60, architectureComplexity: "high" } }),
  );
  assert.equal(at50.healthScore, 50);
  assert.equal(at50.healthCategory, "fair");

  // <50 (40): medium (-10) + density 12 (>10, -25) + coverage 0.4 (<1, -25) = 60 -> 40
  const below50 = buildRepositoryHealthSummary(
    overview({ structure: { totalFiles: 5, totalSymbols: 2 }, architecture: { totalDependencies: 60, architectureComplexity: "medium" } }),
  );
  assert.equal(below50.healthScore, 40);
  assert.equal(below50.healthCategory, "poor");
});

test("12. determinism: repeated calls deepEqual", () => {
  const o = overview({ architecture: { architectureComplexity: "medium", totalDependencies: 30 } });
  assert.deepEqual(buildRepositoryHealthSummary(o), buildRepositoryHealthSummary(o));
});

test("13. input immutability", () => {
  const o = overview();
  const snapshot = JSON.parse(JSON.stringify(o));
  buildRepositoryHealthSummary(o);
  assert.deepEqual(o, snapshot);
});

test("14. JSON round-trip preserves the result", () => {
  const result = buildRepositoryHealthSummary(overview());
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
