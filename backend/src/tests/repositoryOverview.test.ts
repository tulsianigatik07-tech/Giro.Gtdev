import test from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryOverview } from "../services/repository/repositoryOverview.js";
import { buildRepositoryStructureSummary } from "../services/repository/repositoryStructureSummary.js";
import { buildRepositoryArchitectureSummary } from "../services/repository/repositoryArchitectureSummary.js";
import type { RepositoryIndexMetadata } from "../services/repository/indexingTypes.js";
import type { DependencyGraph } from "../services/graph/types.js";

function meta(overrides?: Partial<RepositoryIndexMetadata>): RepositoryIndexMetadata {
  return {
    owner: "acme",
    repo: "demo",
    status: "indexed",
    indexedAt: "2020-01-01T00:00:00.000Z",
    lastAccessedAt: "2020-01-01T00:00:00.000Z",
    chunkCount: 10,
    fileCount: 5,
    symbolCount: 7,
    graphNodeCount: 3,
    graphEdgeCount: 2,
    summaryAvailable: true,
    firstIndexedAt: "2020-01-01T00:00:00.000Z",
    lastIndexedAt: "2020-01-01T00:00:00.000Z",
    totalIndexedFiles: 5,
    lastIndexMode: "full",
    lastChangedFileCount: 0,
    lastFailureAt: null,
    failureReason: null,
    failedFileCount: 0,
    lastSuccessfulFile: null,
    retryCount: 0,
    lastRetryAt: null,
    ...overrides,
  };
}

function graph(
  filePaths: string[],
  edges: Array<{ from: string; to: string }>,
): DependencyGraph {
  return {
    nodes: filePaths.map((filePath) => ({ filePath })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, importedSymbols: [] })),
    stats: {},
    insights: {},
  } as unknown as DependencyGraph;
}

function assertNoUndefined(value: unknown, path = "overview"): void {
  if (value === undefined) assert.fail(`undefined at ${path}`);
  if (value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
  }
}

test("1. returns both structure and architecture sections", () => {
  const overview = buildRepositoryOverview(meta(), graph(["a", "b"], [{ from: "a", to: "b" }]));
  assert.deepEqual(Object.keys(overview).sort(), ["architecture", "structure"]);
});

test("2. structure deep-equals a direct structure-summary call", () => {
  const m = meta({ fileCount: 120 });
  const overview = buildRepositoryOverview(m, graph(["a"], []));
  assert.deepEqual(overview.structure, buildRepositoryStructureSummary(m));
});

test("3. architecture deep-equals a direct architecture-summary call", () => {
  const g = graph(["a", "b", "c"], [{ from: "a", to: "b" }]);
  const overview = buildRepositoryOverview(meta(), g);
  assert.deepEqual(overview.architecture, buildRepositoryArchitectureSummary(g));
});

test("4. determinism across repeated calls", () => {
  const m = meta({ fileCount: 300 });
  const g = graph(["a", "b"], [{ from: "a", to: "b" }]);
  assert.deepEqual(buildRepositoryOverview(m, g), buildRepositoryOverview(m, g));
});

test("5. metadata input immutability", () => {
  const m = meta();
  const snapshot = JSON.parse(JSON.stringify(m));
  buildRepositoryOverview(m, graph(["a"], []));
  assert.deepEqual(m, snapshot);
});

test("6. graph input immutability", () => {
  const g = graph(["b", "a"], [{ from: "a", to: "b" }]);
  const snapshot = JSON.parse(JSON.stringify(g));
  buildRepositoryOverview(meta(), g);
  assert.deepEqual(g, snapshot);
});

test("7. empty repository case (zeroed metadata + empty graph)", () => {
  const overview = buildRepositoryOverview(
    meta({
      fileCount: 0,
      chunkCount: 0,
      symbolCount: 0,
      graphNodeCount: 0,
      graphEdgeCount: 0,
      summaryAvailable: false,
    }),
    graph([], []),
  );
  assert.equal(overview.structure.totalFiles, 0);
  assert.equal(overview.structure.repositoryScale, "small");
  assert.equal(overview.architecture.totalFiles, 0);
  assert.equal(overview.architecture.architectureComplexity, "low");
});

test("8. large repository case", () => {
  const files = Array.from({ length: 400 }, (_, i) => `src/f${i}.ts`);
  const edges = Array.from({ length: 2000 }, () => ({ from: "src/f0.ts", to: "src/f1.ts" }));
  const overview = buildRepositoryOverview(meta({ fileCount: 400 }), graph(files, edges));
  assert.equal(overview.structure.repositoryScale, "large");
  assert.equal(overview.architecture.totalFiles, 400);
  assert.equal(overview.architecture.architectureComplexity, "high"); // 2000/400 = 5
});

test("9. zero-file graph case (no nodes/edges)", () => {
  const overview = buildRepositoryOverview(meta(), graph([], []));
  assert.equal(overview.architecture.averageDependenciesPerFile, 0);
  assert.equal(overview.architecture.connectedFiles, 0);
  assert.equal(overview.architecture.isolatedFiles, 0);
});

test("10. structure and architecture sections are independent", () => {
  const g = graph(["a", "b"], [{ from: "a", to: "b" }]);
  const small = buildRepositoryOverview(meta({ fileCount: 10 }), g);
  const large = buildRepositoryOverview(meta({ fileCount: 1000 }), g);
  // changing metadata.fileCount changes structure but NOT architecture
  assert.notEqual(small.structure.repositoryScale, large.structure.repositoryScale);
  assert.deepEqual(small.architecture, large.architecture);
});

test("11. JSON round-trip preserves the overview", () => {
  const overview = buildRepositoryOverview(meta(), graph(["a", "b"], [{ from: "a", to: "b" }]));
  assert.deepEqual(JSON.parse(JSON.stringify(overview)), overview);
});

test("12. no field anywhere in the output is undefined", () => {
  const overview = buildRepositoryOverview(meta(), graph(["a", "b"], [{ from: "a", to: "b" }]));
  assertNoUndefined(overview);
});
