import type { RepositoryHealthReport } from "./repositoryHealthReport.js";

export interface RepositoryAnalysisReport {
  repositoryName: string;
  health: RepositoryHealthReport;
  overview: string;
  structureSummary: string;
}

export function buildRepositoryAnalysisReport(input: {
  repositoryName: string;
  health: RepositoryHealthReport;
  overview: string;
  structureSummary: string;
}): RepositoryAnalysisReport {
  return {
    repositoryName: input.repositoryName,
    health: input.health,
    overview: input.overview,
    structureSummary: input.structureSummary,
  };
}