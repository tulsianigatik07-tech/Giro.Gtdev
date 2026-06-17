import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getFileSymbolMaps,
  clearGraphSourceStore,
} from "../services/repository/graphSourceStore.js";
import { planGraphUpdate } from "../services/repository/graphUpdatePlanner.js";
import { applyGraphUpdate } from "../services/repository/graphUpdateService.js";
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

const EMPTY = { added: [], modified: [], removed: [] };

beforeEach(() => {
  clearGraphSourceStore();
  clearRepositoryIndexRegistry();
});

test("1. added file creates its node + edges", () => {
  applyGraphUpdate("o", "r", { added: [fileMap("src/b.ts")], modified: [], removed: [] });
  const g = applyGraphUpdate("o", "r", { added: [fileMap("src/a.ts", ["./b.js"])], modified: [], removed: [] });
  assert.ok(g.nodes.some((n) => n.filePath === "src/a.ts"));
  assert.ok(g.edges.some((e) => e.from === "src/a.ts" && e.to === "src/b.ts"));
});

test("2. modified file refreshes its node/edges (changed imports -> changed edges)", () => {
  applyGraphUpdate("o", "r", { added: [fileMap("src/a.ts"), fileMap("src/b.ts")], modified: [], removed: [] });
  const g = applyGraphUpdate("o", "r", { added: [], modified: [fileMap("src/a.ts", ["./b.js"])], removed: [] });
  assert.ok(g.edges.some((e) => e.from === "src/a.ts" && e.to === "src/b.ts"));
});

test("3. removed file prunes its node + incident edges", () => {
  applyGraphUpdate("o", "r", { added: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts")], modified: [], removed: [] });
  const g = applyGraphUpdate("o", "r", { added: [], modified: [], removed: ["src/b.ts"] });
  assert.ok(!g.nodes.some((n) => n.filePath === "src/b.ts"));
  assert.ok(!g.edges.some((e) => e.to === "src/b.ts"));
});

test("4. mixed added + modified + removed in one update", () => {
  applyGraphUpdate("o", "r", {
    added: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts"), fileMap("src/c.ts")],
    modified: [],
    removed: [],
  });
  const g = applyGraphUpdate("o", "r", {
    added: [fileMap("src/d.ts", ["./c.js"])],
    modified: [fileMap("src/a.ts", ["./c.js"])],
    removed: ["src/b.ts"],
  });
  assert.ok(!g.nodes.some((n) => n.filePath === "src/b.ts"));
  assert.ok(g.nodes.some((n) => n.filePath === "src/d.ts"));
  assert.ok(g.edges.some((e) => e.from === "src/a.ts" && e.to === "src/c.ts"));
  assert.ok(g.edges.some((e) => e.from === "src/d.ts" && e.to === "src/c.ts"));
  assert.ok(!g.edges.some((e) => e.to === "src/b.ts"));
});

test("5. planner output correct + deterministically sorted (incl. neighbors)", () => {
  const currentMaps = [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts"), fileMap("src/c.ts")];
  const plan = planGraphUpdate({
    added: [fileMap("src/d.ts")],
    modified: [fileMap("src/a.ts", ["./b.js"])],
    removed: ["src/c.ts"],
    currentMaps,
  });
  assert.deepEqual(plan.nodesToAdd, ["src/d.ts"]);
  assert.deepEqual(plan.nodesToRefresh, ["src/a.ts"]);
  assert.deepEqual(plan.nodesToRemove, ["src/c.ts"]);
  // a.ts<->b.ts edge means b.ts is a neighbor of the modified a.ts
  assert.deepEqual(plan.affectedFiles, ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
  assert.deepEqual(plan.edgesToRefresh, [{ from: "src/a.ts", to: "src/b.ts" }]);
});

test("6. FULL-REBUILD EQUIVALENCE: incremental == one-shot build of final set", () => {
  applyGraphUpdate("o", "r", { added: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts")], modified: [], removed: [] });
  applyGraphUpdate("o", "r", { added: [fileMap("src/c.ts", ["./a.js"])], modified: [], removed: [] });
  const incremental = applyGraphUpdate("o", "r", { added: [], modified: [fileMap("src/a.ts", ["./b.js", "./c.js"])], removed: [] });

  const fullBuild = oneShot(getFileSymbolMaps("o/r"));
  assert.deepEqual(incremental, fullBuild);
});

test("7. untouched files' source maps preserved exactly", () => {
  const b = fileMap("src/b.ts", ["./c.js"]);
  applyGraphUpdate("o", "r", { added: [fileMap("src/a.ts"), b, fileMap("src/c.ts")], modified: [], removed: [] });
  const bBefore = getFileSymbolMaps("o/r").find((m) => m.filePath === "src/b.ts");
  applyGraphUpdate("o", "r", { added: [], modified: [fileMap("src/a.ts", ["./b.js"])], removed: [] });
  const bAfter = getFileSymbolMaps("o/r").find((m) => m.filePath === "src/b.ts");
  assert.deepEqual(bAfter, bBefore);
});

test("8. repeated identical update sequences are deepEqual", () => {
  const run = (owner: string) => {
    applyGraphUpdate(owner, "r", { added: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts")], modified: [], removed: [] });
    return applyGraphUpdate(owner, "r", { added: [fileMap("src/c.ts", ["./a.js"])], modified: [], removed: [] });
  };
  assert.deepEqual(run("o1"), run("o2"));
});

test("9. empty update is a deterministic no-op / empty graph", () => {
  const empty = applyGraphUpdate("o", "r", EMPTY);
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);
  assert.equal(empty.stats.totalNodes, 0);
  assert.equal(empty.stats.totalEdges, 0);

  applyGraphUpdate("o", "r", { added: [fileMap("src/a.ts")], modified: [], removed: [] });
  const after = applyGraphUpdate("o", "r", EMPTY);
  assert.equal(getFileSymbolMaps("o/r").length, 1);
  assert.equal(after.nodes.length, 1);
});

test("10. ownership isolation: updating repoA never affects repoB", () => {
  applyGraphUpdate("o", "a", { added: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts")], modified: [], removed: [] });
  applyGraphUpdate("o", "b", { added: [fileMap("src/x.ts")], modified: [], removed: [] });
  const bSourceBefore = getFileSymbolMaps("o/b");

  applyGraphUpdate("o", "a", { added: [], modified: [], removed: ["src/b.ts"] });

  assert.deepEqual(getFileSymbolMaps("o/b"), bSourceBefore);
});

test("11. registry graph counts update to recomputed graph (additive updater)", () => {
  setRepositoryIndexed("o", "r", COUNTS);
  const g = applyGraphUpdate("o", "r", { added: [fileMap("src/a.ts", ["./b.js"]), fileMap("src/b.ts")], modified: [], removed: [] });
  updateRepositoryGraphCounts("o", "r", g.nodes.length, g.edges.length);
  const meta = getRepositoryIndexMetadata("o", "r");
  assert.equal(meta?.graphNodeCount, 2);
  assert.equal(meta?.graphEdgeCount, 1);
});
