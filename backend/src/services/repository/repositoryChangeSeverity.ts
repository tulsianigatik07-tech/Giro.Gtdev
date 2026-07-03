import type { RepositoryChangeSummary } from "./repositoryChangeDetector.js";

export type RepositoryChangeSeverity = "none" | "low" | "medium" | "high";

export function assessRepositoryChangeSeverity(
  summary: RepositoryChangeSummary,
): RepositoryChangeSeverity {
  if (summary.totalChanges === 0) {
    return "none";
  }

  if (summary.totalChanges < 5) {
    return "low";
  }

  if (summary.totalChanges < 20) {
    return "medium";
  }

  return "high";
}