// Pure, deterministic changed-file detection based ONLY on file-path identity.
//
// Supported states: added, removed, unchanged.
// NOT supported: modified (there is no hash/mtime/content/size comparison).
//
// Purity: inputs are never mutated. Output arrays are sorted ascending.

import type { ScannedFile } from "./scanner.js";
import type { SnapshotFile } from "./fileSnapshotStore.js";

// Full-reindex thresholds (deterministic constants).
// CHANGE_RATIO_THRESHOLD: when (added + removed) / max(previous, 1) exceeds
// this fraction, the delta is large enough that a full reindex is cheaper/safer.
export const CHANGE_RATIO_THRESHOLD = 0.5;
// REMOVED_RATIO_THRESHOLD: when removed / max(previous, 1) exceeds this
// fraction, too much of the prior index is gone to trust an incremental update.
export const REMOVED_RATIO_THRESHOLD = 0.3;

export interface ChangedFileResult {
  added: string[];
  removed: string[];
  unchanged: string[];
  totalChangedFiles: number;
  shouldReindexFully: boolean;
}

export function detectChangedFiles(
  previous: SnapshotFile[] | null,
  current: ScannedFile[],
): ChangedFileResult {
  const previousPaths = new Set((previous ?? []).map((f) => f.filePath));
  const currentPaths = new Set(current.map((f) => f.filePath));

  const added: string[] = [];
  const unchanged: string[] = [];
  for (const path of currentPaths) {
    if (previousPaths.has(path)) {
      unchanged.push(path);
    } else {
      added.push(path);
    }
  }

  const removed: string[] = [];
  for (const path of previousPaths) {
    if (!currentPaths.has(path)) {
      removed.push(path);
    }
  }

  added.sort((a, b) => a.localeCompare(b));
  removed.sort((a, b) => a.localeCompare(b));
  unchanged.sort((a, b) => a.localeCompare(b));

  const totalChangedFiles = added.length + removed.length;

  const previousLength = previous?.length ?? 0;
  const denominator = Math.max(previousLength, 1);
  const changeRatio = totalChangedFiles / denominator;
  const removedRatio = removed.length / denominator;

  const shouldReindexFully =
    previous === null ||
    (current.length === 0 && previousLength > 0) ||
    changeRatio > CHANGE_RATIO_THRESHOLD ||
    removedRatio > REMOVED_RATIO_THRESHOLD;

  return { added, removed, unchanged, totalChangedFiles, shouldReindexFully };
}
