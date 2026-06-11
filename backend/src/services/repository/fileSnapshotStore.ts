// In-memory repository file-snapshot registry. Maps repoId ("owner/repo") ->
// the last indexed file list. Intentionally temporary: snapshots are lost on
// restart, mirroring the other in-memory stores. A schema-backed persistence
// layer will replace this in a future phase.
//
// Determinism contract:
// - module-level singleton Map
// - shallow-copy on read (callers cannot mutate stored state)
// - saving overwrites any existing snapshot for the same repo
// - no UUIDs, randomness, timers, or async jobs

import type { ScannedFile } from "./scanner.js";

export interface SnapshotFile {
  filePath: string;
  size: number;
  language: string;
  lastSeenAt: string;
}

export interface RepositoryFileSnapshot {
  files: SnapshotFile[];
  updatedAt: string;
}

const store = new Map<string, RepositoryFileSnapshot>();

export function saveRepositoryFileSnapshot(
  repoId: string,
  files: ScannedFile[],
): void {
  const updatedAt = new Date().toISOString();
  const snapshotFiles: SnapshotFile[] = files.map((f) => ({
    filePath: f.filePath,
    size: f.size,
    language: f.language,
    lastSeenAt: updatedAt,
  }));
  store.set(repoId, { files: snapshotFiles, updatedAt });
}

export function getRepositoryFileSnapshot(
  repoId: string,
): RepositoryFileSnapshot | null {
  const found = store.get(repoId);
  if (!found) return null;
  return {
    files: found.files.map((f) => ({ ...f })),
    updatedAt: found.updatedAt,
  };
}

export function clearRepositoryFileSnapshots(): void {
  store.clear();
}
