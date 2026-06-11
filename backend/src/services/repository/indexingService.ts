// Determinism contract:
// - listIndexedRepositories() sort is stable: owner asc, repo asc
// - All timestamps are ISO 8601 via new Date().toISOString()
// - No randomness, UUIDs, async jobs, or timers
// - Same store state always produces identical outputs
// - Store is module-level singleton reset on process restart

import type {
  RepositoryIndexMetadata,
  RepositoryIndexStatus,
} from "./indexingTypes.js";

const store = new Map<string, RepositoryIndexMetadata>();

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function defaultMetadata(owner: string, repo: string): RepositoryIndexMetadata {
  return {
    owner,
    repo,
    status: "indexing",
    indexedAt: null,
    lastAccessedAt: null,
    chunkCount: 0,
    fileCount: 0,
    symbolCount: 0,
    graphNodeCount: 0,
    graphEdgeCount: 0,
    summaryAvailable: false,
    firstIndexedAt: null,
    lastIndexedAt: null,
    totalIndexedFiles: 0,
  };
}

export interface IndexedCounts {
  chunkCount: number;
  fileCount: number;
  symbolCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  summaryAvailable: boolean;
}

export function getRepositoryIndexMetadata(
  owner: string,
  repo: string,
): RepositoryIndexMetadata | null {
  const found = store.get(repoKey(owner, repo));
  return found ? { ...found } : null;
}

export function setRepositoryIndexing(owner: string, repo: string): void {
  const key = repoKey(owner, repo);
  const existing = store.get(key) ?? defaultMetadata(owner, repo);
  store.set(key, { ...existing, status: "indexing" });
}

export function setRepositoryIndexed(
  owner: string,
  repo: string,
  counts: IndexedCounts,
): void {
  const key = repoKey(owner, repo);
  const existing = store.get(key) ?? defaultMetadata(owner, repo);
  const now = new Date().toISOString();
  store.set(key, {
    ...existing,
    status: "indexed",
    indexedAt: now,
    chunkCount: counts.chunkCount,
    fileCount: counts.fileCount,
    symbolCount: counts.symbolCount,
    graphNodeCount: counts.graphNodeCount,
    graphEdgeCount: counts.graphEdgeCount,
    summaryAvailable: counts.summaryAvailable,
    firstIndexedAt: existing.firstIndexedAt ?? now,
    lastIndexedAt: now,
    totalIndexedFiles: counts.fileCount,
  });
}

export function setRepositoryFailed(owner: string, repo: string): void {
  const key = repoKey(owner, repo);
  const existing = store.get(key) ?? defaultMetadata(owner, repo);
  store.set(key, { ...existing, status: "failed" });
}

export function markRepositoryStale(owner: string, repo: string): void {
  const key = repoKey(owner, repo);
  const existing = store.get(key);
  if (!existing) return;
  store.set(key, { ...existing, status: "stale" });
}

export function touchRepositoryAccess(owner: string, repo: string): void {
  const key = repoKey(owner, repo);
  const existing = store.get(key);
  if (!existing) return;
  store.set(key, { ...existing, lastAccessedAt: new Date().toISOString() });
}

export function listIndexedRepositories(): RepositoryIndexMetadata[] {
  return [...store.values()]
    .filter((m) => m.status === "indexed")
    .map((m) => ({ ...m }))
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.repo.localeCompare(b.repo));
}

export function isRepositoryHealthy(owner: string, repo: string): boolean {
  return store.get(repoKey(owner, repo))?.status === "indexed";
}

export function isRepositoryStale(owner: string, repo: string): boolean {
  return store.get(repoKey(owner, repo))?.status === "stale";
}

// Status type re-exported for callers that narrow on it.
export type { RepositoryIndexStatus };

// test-only helper — resets in-memory registry
export function clearRepositoryIndexRegistry(): void {
  store.clear();
}
