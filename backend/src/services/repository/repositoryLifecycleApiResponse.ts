import type { RepositoryLifecycleReport } from "./repositoryLifecycleReport.js";
import type { RepositoryLifecycleDashboard } from "./repositoryLifecycleDashboard.js";

export interface RepositoryLifecycleApiResponse {
  lifecycle: RepositoryLifecycleDashboard;
  details: RepositoryLifecycleReport;
  metadata: {
    generatedAt: string;
    version: "v1";
  };
}

export function buildRepositoryLifecycleApiResponse(
  report: RepositoryLifecycleReport,
  dashboard: RepositoryLifecycleDashboard,
): RepositoryLifecycleApiResponse {
  return {
    lifecycle: dashboard,
    details: report,
    metadata: {
      generatedAt: new Date().toISOString(),
      version: "v1",
    },
  };
}