import test from "node:test";
import assert from "node:assert/strict";
import { buildRetrievalContextSummary } from "../services/repository/retrievalContextSummary.js";
import type { RepositoryOverview } from "../services/repository/repositoryOverview.js";
import type { RepositoryHealthSummary } from "../services/repository/repositoryHealthSummary.js";

function overview(overrides?: {
  structure?: Partial<RepositoryOverview["structure"]>;
  architecture?: Partial<RepositoryOverview["architecture"]>;
}): RepositoryOverview {
  return {
    structure: {
      totalFiles: 10,
      totalChunks: 20,
      totalSymbols: 30,
      totalGraphNodes: 10,
      totalGraphEdges: 5,
      summaryAvailable: true,
      repositoryScale: "small",
      ...overrides?.structure,
    },
    architecture: {
      totalFiles: 999, // intentionally different to prove totalFiles source
      totalDependencies: 15,
      averageDependenciesPerFile: 1.5,
      isolatedFiles: 2,
      connectedFiles: 8,
      architectureComplexity: "low",
      ...overrides?.architecture,
    },
  };
}

function health(overrides?: Partial<RepositoryHealthSummary>): RepositoryHealthSummary {
  return {
    scale: "small",
    complexity: "low",
    fileCoverage: 3,
    dependencyDensity: 1.5,
    healthScore: 100,
    healthCategory: "excellent",
    ...overrides,
  };
}

test("1. repositoryScale propagation", () => {
  const r = buildRetrievalContextSummary(overview({ structure: { repositoryScale: "medium" } }), health());
  assert.equal(r.repositoryScale, "medium");
});

test("2. architectureComplexity propagation", () => {
  const r = buildRetrievalContextSummary(overview({ architecture: { architectureComplexity: "high" } }), health());
  assert.equal(r.architectureComplexity, "high");
});

test("3. healthCategory propagation", () => {
  const r = buildRetrievalContextSummary(overview(), health({ healthCategory: "fair" }));
  assert.equal(r.healthCategory, "fair");
});

test("4. totals propagation; totalFiles from structure (not architecture)", () => {
  const r = buildRetrievalContextSummary(
    overview({ structure: { totalFiles: 10, totalSymbols: 30 }, architecture: { totalFiles: 999, totalDependencies: 15 } }),
    health(),
  );
  assert.equal(r.totalFiles, 10); // from structure, NOT 999
  assert.equal(r.totalSymbols, 30);
  assert.equal(r.totalDependencies, 15);
});

test("5. retrievalKeywords has exactly six entries", () => {
  const r = buildRetrievalContextSummary(overview(), health());
  assert.equal(r.retrievalKeywords.length, 6);
});

test("6. keyword ordering is exact", () => {
  const r = buildRetrievalContextSummary(overview(), health());
  assert.deepEqual(r.retrievalKeywords.map((k) => k.split(":")[0]), [
    "scale",
    "complexity",
    "health",
    "files",
    "symbols",
    "dependencies",
  ]);
});

test("7. keyword formatting is exact", () => {
  const r = buildRetrievalContextSummary(
    overview({ structure: { totalFiles: 10, totalSymbols: 30, repositoryScale: "small" }, architecture: { totalDependencies: 15, architectureComplexity: "low" } }),
    health({ healthCategory: "excellent" }),
  );
  assert.deepEqual(r.retrievalKeywords, [
    "scale:small",
    "complexity:low",
    "health:excellent",
    "files:10",
    "symbols:30",
    "dependencies:15",
  ]);
});

test("8. small repository example", () => {
  const r = buildRetrievalContextSummary(overview({ structure: { repositoryScale: "small" } }), health());
  assert.equal(r.repositoryScale, "small");
  assert.equal(r.retrievalKeywords[0], "scale:small");
});

test("9. medium repository example", () => {
  const r = buildRetrievalContextSummary(overview({ structure: { repositoryScale: "medium" } }), health());
  assert.equal(r.retrievalKeywords[0], "scale:medium");
});

test("10. large repository example", () => {
  const r = buildRetrievalContextSummary(overview({ structure: { repositoryScale: "large" } }), health());
  assert.equal(r.retrievalKeywords[0], "scale:large");
});

test("11. excellent health example", () => {
  const r = buildRetrievalContextSummary(overview(), health({ healthCategory: "excellent" }));
  assert.equal(r.healthCategory, "excellent");
  assert.equal(r.retrievalKeywords[2], "health:excellent");
});

test("12. poor health example", () => {
  const r = buildRetrievalContextSummary(overview(), health({ healthCategory: "poor" }));
  assert.equal(r.healthCategory, "poor");
  assert.equal(r.retrievalKeywords[2], "health:poor");
});

test("13. determinism: repeated calls deepEqual", () => {
  const o = overview({ structure: { repositoryScale: "large" } });
  const h = health({ healthCategory: "good" });
  assert.deepEqual(buildRetrievalContextSummary(o, h), buildRetrievalContextSummary(o, h));
});

test("14. input immutability for both inputs", () => {
  const o = overview();
  const h = health();
  const oSnap = JSON.parse(JSON.stringify(o));
  const hSnap = JSON.parse(JSON.stringify(h));
  buildRetrievalContextSummary(o, h);
  assert.deepEqual(o, oSnap);
  assert.deepEqual(h, hSnap);
});

test("15. JSON round-trip preserves the result", () => {
  const r = buildRetrievalContextSummary(overview(), health());
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});
