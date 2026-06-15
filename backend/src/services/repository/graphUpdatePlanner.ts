// Pure, descriptive planner for an incremental graph update. Documents the
// impacted region (changed/removed nodes, their graph neighbors, and incident
// edges) from the CURRENT graph state. Diagnostic only — correctness of the
// resulting graph comes from graphUpdateExecutor (full recompute). Inputs are
// never mutated; all output arrays are deterministically sorted.

import { buildDependencyGraph } from "../graph/graphBuilder.js";
import type { FileSymbolMap } from "../graph/types.js";

export interface GraphUpdatePlan {
  nodesToRefresh: string[];
  nodesToRemove: string[];
  edgesToRefresh: Array<{ from: string; to: string }>;
  affectedFiles: string[];
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function planGraphUpdate(input: {
  changed: FileSymbolMap[];
  removed: string[];
  currentMaps: FileSymbolMap[];
}): GraphUpdatePlan {
  const changedPaths = input.changed.map((m) => m.filePath);
  const removedPaths = [...input.removed];
  const directly = new Set<string>([...changedPaths, ...removedPaths]);

  // Use the real resolver (via buildDependencyGraph over the CURRENT maps) to
  // find graph neighbors of directly-affected files.
  const { edges } = buildDependencyGraph(input.currentMaps);

  const affected = new Set<string>(directly);
  for (const e of edges) {
    if (directly.has(e.from)) affected.add(e.to);
    if (directly.has(e.to)) affected.add(e.from);
  }

  const edgesToRefresh = edges
    .filter((e) => affected.has(e.from) || affected.has(e.to))
    .map((e) => ({ from: e.from, to: e.to }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return {
    nodesToRefresh: sortUnique(changedPaths),
    nodesToRemove: sortUnique(removedPaths),
    edgesToRefresh,
    affectedFiles: sortUnique([...affected]),
  };
}
