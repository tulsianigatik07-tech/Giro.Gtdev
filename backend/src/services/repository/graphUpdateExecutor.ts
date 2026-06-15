// Pure incremental graph update executor. Applies changed/removed files to the
// per-file graph source store, then RECOMPUTES the full dependency graph from
// the resulting source set using the existing builder. Recomputing in full
// guarantees correct GLOBAL metrics (degrees, centrality, stats, insights) and
// full-rebuild equivalence — partial mutation is not correctness-safe because
// node metrics are global.

import {
  setFileSymbolMap,
  removeFileSymbolMap,
  getFileSymbolMaps,
} from "./graphSourceStore.js";
import {
  buildDependencyGraph,
  computeStats,
  detectInsights,
} from "../graph/graphBuilder.js";
import type { DependencyGraph, FileSymbolMap } from "../graph/types.js";

export function applyGraphUpdate(
  owner: string,
  repo: string,
  input: { changed: FileSymbolMap[]; removed: string[] },
): DependencyGraph {
  const repoId = `${owner}/${repo}`;

  for (const filePath of input.removed) {
    removeFileSymbolMap(repoId, filePath);
  }
  for (const map of input.changed) {
    setFileSymbolMap(repoId, map);
  }

  const maps = getFileSymbolMaps(repoId);
  const { nodes, edges } = buildDependencyGraph(maps);
  const stats = computeStats(nodes, edges);
  const insights = detectInsights(nodes, edges);

  return { nodes, edges, stats, insights };
}
