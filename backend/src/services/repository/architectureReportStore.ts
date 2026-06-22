export interface ArchitectureStoredReport {
  repositoryId: string;
  generatedAt: string;
  report: unknown;
}

const architectureReports = new Map<string, ArchitectureStoredReport>();

export function saveArchitectureReport(
  report: ArchitectureStoredReport,
): void {
  architectureReports.set(report.repositoryId, report);
}

export function getArchitectureReport(
  repositoryId: string,
): ArchitectureStoredReport | undefined {
  return architectureReports.get(repositoryId);
}

export function listArchitectureReports(): ArchitectureStoredReport[] {
  return [...architectureReports.values()];
}

export function deleteArchitectureReport(
  repositoryId: string,
): boolean {
  return architectureReports.delete(repositoryId);
}

export function clearArchitectureReports(): void {
  architectureReports.clear();
}