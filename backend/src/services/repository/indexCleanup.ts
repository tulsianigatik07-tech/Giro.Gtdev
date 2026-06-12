// Incremental deletion cleanup foundation.
//
// When a repository is re-indexed, files that disappeared since the last
// snapshot must eventually have their derived intelligence (chunks, symbols,
// graph nodes, file metadata) removed from future index stores. This module is
// the FOUNDATION for that: it deterministically identifies what needs cleanup.
//
// Scope (this commit): metadata/foundation only.
// - Does NOT delete files from disk
// - Does NOT remove cloned repos or touch Git state
// - Does NOT touch retrieval/rerank/confidence/prompt systems
// - Does NOT persist anything (no DB, no Redis, no queues)
//
// Determinism guarantees:
// - removedFiles are de-duplicated and sorted ascending
// - no randomness, no UUIDs, no timestamps
// - inputs are never mutated

import type { RepositoryIndexingPlan } from "./indexingPlan.js";

export interface IndexCleanupPlan {
  removedFiles: string[]; // de-duplicated, sorted ascending
  cleanupRequired: boolean;
  reason: string;
}

export interface IndexCleanupResult {
  removedFiles: string[]; // de-duplicated, sorted ascending
  cleanedFileCount: number;
  skippedFileCount: number;
  cleanupRequired: boolean;
  reason: string;
}

function normalizeRemoved(removedFiles: readonly string[]): string[] {
  // De-duplicate then sort — never mutate the caller's array.
  return [...new Set(removedFiles)].sort((a, b) => a.localeCompare(b));
}

// Pure: builds a cleanup plan from a raw removed-files list.
export function buildIndexCleanupPlan(
  removedFiles: readonly string[],
): IndexCleanupPlan {
  const normalized = normalizeRemoved(removedFiles);
  const cleanupRequired = normalized.length > 0;
  return {
    removedFiles: normalized,
    cleanupRequired,
    reason: cleanupRequired
      ? `${normalized.length} removed file(s) require cleanup`
      : "no removed files",
  };
}

// Convenience: derive the cleanup plan directly from an indexing plan.
export function buildIndexCleanupPlanFromIndexingPlan(
  plan: RepositoryIndexingPlan,
): IndexCleanupPlan {
  return buildIndexCleanupPlan(plan.removedFiles);
}

// Executes the cleanup foundation. Today this only resolves counts from the
// plan (no real store deletions exist yet); future commits will remove stale
// chunks/symbols/graph nodes/file metadata here. Deterministic and side-effect
// free in this commit.
export function executeIndexCleanup(
  plan: IndexCleanupPlan,
): IndexCleanupResult {
  return {
    removedFiles: [...plan.removedFiles],
    cleanedFileCount: plan.removedFiles.length,
    skippedFileCount: 0,
    cleanupRequired: plan.cleanupRequired,
    reason: plan.reason,
  };
}
