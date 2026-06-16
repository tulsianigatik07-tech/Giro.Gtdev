// Pure retry planner. A retry is eligible ONLY when the repo's current status
// is "failed". Computes the remaining (not-yet-completed) files and the
// preserved (already-indexed) files. Deterministic; inputs never mutated.

import { getRepositoryIndexMetadata } from "./indexingService.js";

export interface RetryPlan {
  eligible: boolean;
  remainingFiles: string[];
  preservedFiles: string[];
}

function sortUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function retryFailedIndexing(
  owner: string,
  repo: string,
  input: { allFiles: string[]; completedFiles: string[] },
): RetryPlan {
  const status = getRepositoryIndexMetadata(owner, repo)?.status;
  if (status !== "failed") {
    return { eligible: false, remainingFiles: [], preservedFiles: [] };
  }

  const completed = new Set(input.completedFiles);
  const remainingFiles = sortUnique(input.allFiles.filter((f) => !completed.has(f)));
  const preservedFiles = sortUnique(input.allFiles.filter((f) => completed.has(f)));

  return { eligible: true, remainingFiles, preservedFiles };
}
