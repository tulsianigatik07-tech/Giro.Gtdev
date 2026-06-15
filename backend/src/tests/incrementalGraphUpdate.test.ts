import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getFileSymbolMaps,
  clearGraphSourceStore,
} from "../services/repository/graphSourceStore.js";
import { planGraphUpdate } from "../services/repository/graphUpdatePlanner.js";
import { applyGraphUpdate } from "../services/repository/graphUpdateExecutor.js";
import {
  buildDependencyGraph,
  computeStats,
  detectInsights,
} from "../services/graph/graphBuilder.js";
import {
  setRepositoryIndexed,
  getRepositoryIndexMetadata,
  updateRepositoryGraphCounts,
  clearRepositoryIndexRegistry,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import type { DependencyGraph, FileImport, FileSymbolMap } from "../services/graph/types.js";

const COUNTS: IndexedCounts = {
  chunkCount: 0,
  fileCount: 0,
  symbolCount: 0,
  graphNodeCount: 0,
  graphEdgeCount: 0,
  summaryAvailable: false,
};

function imp(source: string): FileImport {
  return { source, specifiers: [], isRelative: source.startsWith(".") };
}

function fileMap(filePath: string, imports: string[] = []): FileSymbolMap {
  return {
    filePath,
    language: "typescript",
    symbols: [{ name: "x", kind: "function", exported: true, line: 1 }],
    imports: imports.map(imp),
  };
}

function oneShot(maps: FileSymbolMap[]): DependencyGraph {
  const { nodes, edges } = buildDependencyGraph(maps);
  return { nodes, edges, stats: computeStats(nodes, edges), insights: detectInsights(nodes, edges) };
}

beforeEach(() => {
  clearGraphSourceStore();
  clearRepositoryIndexRegistry();
});

test("1. changed file refreshes its node/edges (new imports -> new edges)", () => {
  applyGraphUpdate("o", "r", { changed: [fileMap("src/a.ts"), fileMap("src/b.ts")], removed: [] });
  // now a.ts starts importing b.ts
  const g = applyGraphUpdate("o", "r", { changed: [fileMap("src/a.ts", ["./b.js"])], removed: [] });
  assert.ok(g.edges.some((e) => e.from === "src/a.ts" && e.to === "src/b.ts"));
});

test("2. removed file prunes its node and incident edges", () => {
  applyGraphUpdate("o", "r", { changed: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts")], removed: [] });
  const g = applyGraphUpdate("o", "r", { changed: [], removed: ["src/b.ts"] });
  assert.ok(!g.nodes.some((n) => n.filePath === "src/b.ts"));
  assert.ok(!g.edges.some((e) => e.to === "src/b.ts"));
});

test("3. mixed changed + removed in one update", () => {
  applyGraphUpdate("o", "r", {
    changed: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts"), fileMap("src/c.ts")],
    removed: [],
  });
  const g = applyGraphUpdate("o", "r", { changed: [fileMap("src/a.ts", ["./c.js"])], removed: ["src/b.ts"] });
  assert.ok(!g.nodes.some((n) => n.filePath === "src/b.ts"));
  assert.ok(g.edges.some((e) => e.from === "src/a.ts" && e.to === "src/c.ts"));
  assert.ok(!g.edges.some((e) => e.to === "src/b.ts"));
});

test("4. planner output is correct and deterministically sorted (incl. neighbors)", () => {
  const currentMaps = [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts"), fileMap("src/c.ts")];
  const plan = planGraphUpdate({ changed: [fileMap("src/a.ts", ["./b.js"])], removed: [], currentMaps });
  assert.deepEqual(plan.nodesToRefresh, ["src/a.ts"]);
  assert.deepEqual(plan.nodesToRemove, []);
  // a.ts -> b.ts edge means b.ts is a neighbor of the changed a.ts
  assert.deepEqual(plan.affectedFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(plan.edgesToRefresh, [{ from: "src/a.ts", to: "src/b.ts" }]);
});

test("5. metadata graph counts update to recomputed graph", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  const g = applyGraphUpdate("o", "r", { changed: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts")], removed: [] });
  updateRepositoryGraphCounts("o", "r", g.nodes.length, g.edges.length);
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.equal(meta?.graphNodeCount, g.nodes.length);
  assert.equal(meta?.graphEdgeCount, g.edges.length);
  assert.equal(meta?.graphNodeCount, 2);
  assert.equal(meta?.graphEdgeCount, 1);
});

test("6. FULL-REBUILD EQUIVALENCE: incremental == one-shot build of final set", () => {
  applyGraphUpdate("o", "r", { changed: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts")], removed: [] });
  applyGraphUpdate("o", "r", { changed: [fileMap("src/c.ts", ["./a.js"])], removed: [] });
  const incremental = applyGraphUpdate("o", "r", { changed: [fileMap("src/a.ts", ["./b.js", "./c.js"])], removed: [] });

  // Equivalent final set (what the store holds now).
  const finalMaps = getFileSymbolMaps("o/r");
  const fullBuild = oneShot(finalMaps);

  assert.deepEqual(incremental, fullBuild);
});

test("7. untouched files' source maps preserved exactly", () => {
  const b = fileMap("src/b.ts", ["./c.js"]);
  applyGraphUpdate("o", "r", { changed: [fileMap("src/a.ts"), b, fileMap("src/c.ts")], removed: [] });
  const bBefore = getFileSymbolMaps("o/r").find((m) => m.filePath === "src/b.ts");
  applyGraphUpdate("o", "r", { changed: [fileMap("src/a.ts", ["./b.js"])], removed: [] });
  const bAfter = getFileSymbolMaps("o/r").find((m) => m.filePath === "src/b.ts");
  assert.deepEqual(bAfter, bBefore);
});

test("8. repeated identical update sequences are deepEqual", () => {
  const run = (owner: string) => {
    applyGraphUpdate(owner, "r", { changed: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts")], removed: [] });
    return applyGraphUpdate(owner, "r", { changed: [fileMap("src/c.ts", ["./a.js"])], removed: [] });
  };
  assert.deepEqual(run("o1"), run("o2"));
});

test("9. empty update is a deterministic no-op / empty graph", () => {
  const empty = applyGraphUpdate("o", "r", { changed: [], removed: [] });
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);
  assert.equal(empty.stats.totalNodes, 0);
  assert.equal(empty.stats.totalEdges, 0);

  applyGraphUpdate("o", "r", { changed: [fileMap("src/a.ts")], removed: [] });
  const before = applyGraphUpdate("o", "r", { changed: [], removed: [] });
  const after = getFileSymbolMaps("o/r");
  assert.equal(after.length, 1);
  assert.equal(before.nodes.length, 1);
});

test("10. ownership isolation: updating repoA never affects repoB", () => {
  applyGraphUpdate("o", "a", { changed: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts")], removed: [] });
  applyGraphUpdate("o", "b", { changed: [fileMap("src/x.ts")], removed: [] });
  const bSourceBefore = getFileSymbolMaps("o/b");

  applyGraphUpdate("o", "a", { changed: [], removed: ["src/b.ts"] });

  assert.deepEqual(getFileSymbolMaps("o/b"), bSourceBefore);
  assert.equal(getFileSymbolMaps("o/b").length, 1);
});
