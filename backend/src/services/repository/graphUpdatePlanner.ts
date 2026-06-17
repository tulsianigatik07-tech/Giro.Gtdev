// Pure, descriptive planner for an incremental graph update. Documents the
// impacted region (changed/removed nodes, their graph neighbors, and incident
// edges) from the CURRENT graph state. Diagnostic only — correctness of the
// resulting graph comes from graphUpdateExecutor (full recompute). Inputs are
// never mutated; all output arrays are deterministically sorted.

import { buildDependencyGraph } from "../graph/graphBuilder.js";
import type { FileSymbolMap } from "../graph/types.js";

export interface GraphUpdatePlan {
  nodesToAdd: string[];
  nodesToRefresh: string[];
  nodesToRemove: string[];
  affectedFiles: string[];
  edgesToRefresh: Array<{ from: string; to: string }>;
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function planGraphUpdate(input: {
  added: FileSymbolMap[];
  modified: FileSymbolMap[];
  removed: string[];
  currentMaps: FileSymbolMap[];
}): GraphUpdatePlan {
  const addedPaths = input.added.map((m) => m.filePath);
  const modifiedPaths = input.modified.map((m) => m.filePath);
  const removedPaths = [...input.removed];
  const directly = new Set<string>([...addedPaths, ...modifiedPaths, ...removedPaths]);

  // Use the real resolver (via buildDependencyGraph over the CURRENT maps) to
  // find undirected graph neighbors of directly-affected files.
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
    nodesToAdd: sortUnique(addedPaths),
    nodesToRefresh: sortUnique(modifiedPaths),
    nodesToRemove: sortUnique(removedPaths),
    affectedFiles: sortUnique([...affected]),
    edgesToRefresh,
  };
}
