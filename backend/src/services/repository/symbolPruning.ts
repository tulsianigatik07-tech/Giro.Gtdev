// Removed-file symbol pruning. Pure orchestration callable by future
// incremental execution: drop deleted files' symbols from the index and keep
// the registry's symbolCount accurate. No filesystem, no API/route changes.
//
// Reuses removeFileSymbols (atomic per-file removal preserving deterministic
// ordering) and the additive updateRepositorySymbolCount registry updater.

import {
  removeFileSymbols,
  getRepositorySymbolCount,
} from "./symbolIndexStore.js";
import { updateRepositorySymbolCount } from "./indexingService.js";

export function pruneRemovedFileSymbols(
  owner: string,
  repo: string,
  removedFilePaths: string[],
): void {
  // Empty input -> complete no-op (registry untouched).
  if (removedFilePaths.length === 0) return;

  const repoId = `${owner}/${repo}`;
  for (const filePath of removedFilePaths) {
    removeFileSymbols(repoId, filePath);
  }
  // Reflect actual remaining symbols in the registry metadata.
  updateRepositorySymbolCount(owner, repo, getRepositorySymbolCount(repoId));
}
