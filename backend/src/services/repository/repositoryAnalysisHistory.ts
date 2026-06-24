import type { RepositoryAnalysisReport } from "./repositoryAnalysisReport.js";

export interface RepositoryAnalysisHistoryEntry {
  repositoryName: string;
  report: RepositoryAnalysisReport;
}

const history = new Map<string, RepositoryAnalysisReport[]>();

export function saveRepositoryAnalysisReport(
  repositoryName: string,
  report: RepositoryAnalysisReport,
): void {
  const existing = history.get(repositoryName) ?? [];
  history.set(repositoryName, [...existing, report]);
}

export function getRepositoryAnalysisHistory(
  repositoryName: string,
): RepositoryAnalysisReport[] {
  return [...(history.get(repositoryName) ?? [])];
}

export function clearRepositoryAnalysisHistory(): void {
  history.clear();
}