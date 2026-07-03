import type { RepositoryLifecycleReport } from "./repositoryLifecycleReport.js";

export interface RepositoryLifecycleDashboard {
  severity: string;
  reindexMode: string;
  shouldRun: boolean;
  totalChanges: number;
}

export function buildRepositoryLifecycleDashboard(
  report: RepositoryLifecycleReport,
): RepositoryLifecycleDashboard {
  return {
    severity: report.changes.severity,
    reindexMode: report.plan.mode,
    shouldRun: report.plan.shouldRun,
    totalChanges: report.changes.summary.totalChanges,
  };
}