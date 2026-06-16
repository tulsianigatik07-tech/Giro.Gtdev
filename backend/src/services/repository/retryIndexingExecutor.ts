// Retry executor. Resumes a FAILED index by indexing only the remaining files
// (already-extracted FileSymbolMap[]) without re-processing completed ones, then
// marks the repo "indexed" with recomputed counts and clears failure fields.
// Idempotent: once the repo is "indexed" again, further calls are no-ops.
//
// Preserves previously persisted symbols, graph source maps, and snapshots for
// completed files (per-file upserts; never clear-then-rewrite).

import {
  getRepositoryIndexMetadata,
  setRepositoryIndexed,
  recordIndexingRetry,
  clearIndexingFailure,
} from "./indexingService.js";
import { setFileSymbols, getRepositorySymbolCount } from "./symbolIndexStore.js";
import { setFileSymbolMap, getFileSymbolMaps } from "./graphSourceStore.js";
import { buildDependencyGraph } from "../graph/graphBuilder.js";
import type { FileSymbolMap } from "../graph/types.js";

export function executeRetryIndexing(
  owner: string,
  repo: string,
  work: { remaining: FileSymbolMap[] },
): void {
  const meta = getRepositoryIndexMetadata(owner, repo);
  // Only a failed repo can be retried; otherwise (indexed / absent) no-op.
  if (!meta || meta.status !== "failed") return;

  recordIndexingRetry(owner, repo);

  const repoId = `${owner}/${repo}`;
  for (const map of work.remaining) {
    // Idempotent per-file upserts; completed files are untouched.
    setFileSymbols(repoId, map.filePath, map.symbols);
    setFileSymbolMap(repoId, map);
  }

  // Recompute counts from the full persisted set (completed + newly added).
  const symbolCount = getRepositorySymbolCount(repoId);
  const { nodes, edges } = buildDependencyGraph(getFileSymbolMaps(repoId));

  setRepositoryIndexed(owner, repo, {
    chunkCount: meta.chunkCount,
    fileCount: meta.fileCount,
    symbolCount,
    graphNodeCount: nodes.length,
    graphEdgeCount: edges.length,
    summaryAvailable: meta.summaryAvailable,
  });
  clearIndexingFailure(owner, repo);
}
