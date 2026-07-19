// Per-file graph source store. The dependency graph needs each file's full
// FileSymbolMap (including `imports`, which the symbol index store does NOT
// persist), so incremental graph updates use this as their source of truth.
//
// In-memory Map<repoId, Map<filePath, FileSymbolMap>>; repoId = `${owner}/${repo}`.
// Reads/writes deep-copy so callers cannot mutate stored state. Deterministic.

import type { FileSymbolMap } from "../graph/types.js";

const store = new Map<string, Map<string, FileSymbolMap>>();

function clone(map: FileSymbolMap): FileSymbolMap {
  return structuredClone(map);
}

export function setFileSymbolMap(repoId: string, map: FileSymbolMap): void {
  let repo = store.get(repoId);
  if (!repo) {
    repo = new Map<string, FileSymbolMap>();
    store.set(repoId, repo);
  }
  repo.set(map.filePath, clone(map));
}

export function removeFileSymbolMap(repoId: string, filePath: string): void {
  store.get(repoId)?.delete(filePath);
}

export function getFileSymbolMaps(repoId: string): FileSymbolMap[] {
  const repo = store.get(repoId);
  if (!repo) return [];
  return [...repo.values()]
    .map(clone)
    .sort((a, b) => a.filePath.localeCompare(b.filePath));
}

// test-only helper — resets the in-memory graph source store
export function clearGraphSourceStore(): void {
  store.clear();
}

// Additive: remove a single repo's entire graph-source entry. Idempotent no-op
// for unknown repos; never touches other repos.
export function removeRepositoryGraphSource(repoId: string): void {
  store.delete(repoId);
}

export function replaceRepositoryGraphSource(
  repoId: string,
  maps: readonly FileSymbolMap[],
): void {
  const replacement = new Map<string, FileSymbolMap>();
  for (const map of maps) replacement.set(map.filePath, clone(map));
  store.set(repoId, replacement);
}
