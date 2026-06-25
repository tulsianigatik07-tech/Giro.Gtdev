export interface ArchitectureStoredReport {
  repositoryId: string;
  generatedAt: string;
  report: unknown;
}

const architectureReports = new Map<string, ArchitectureStoredReport>();

export function saveArchitectureReport(
  report: ArchitectureStoredReport,
): void {
  architectureReports.set(report.repositoryId, {
    ...report,
  });
}

export function getArchitectureReport(
  repositoryId: string,
): ArchitectureStoredReport | undefined {
  const report = architectureReports.get(repositoryId);

  if (!report) {
    return undefined;
  }

  return {
    ...report,
  };
}

export function hasArchitectureReport(
  repositoryId: string,
): boolean {
  return architectureReports.has(repositoryId);
}

export function getArchitectureReportCount(): number {
  return architectureReports.size;
}

export function listArchitectureReports(): ArchitectureStoredReport[] {
  return [...architectureReports.values()].map((report) => ({
    ...report,
  }));
}

export function deleteArchitectureReport(
  repositoryId: string,
): boolean {
  return architectureReports.delete(repositoryId);
}

export function clearArchitectureReports(): void {
  architectureReports.clear();
}