import type {
  RepositoryCleanupExecutionReport,
} from "./repositoryCleanupExecutor.js";

export interface RepositoryCleanupSummary {
  totalExecuted: number;
  totalSkipped: number;
}

export interface RepositoryCleanupStatistics {
  executionCoverage: number;
  unsupportedResources: number;
  completionPercentage: number;
}

export interface RepositoryCleanupReport {
  repositoryId: string;
  success: boolean;
  summary: RepositoryCleanupSummary;
  executedResources: string[];
  skippedResources: string[];
  warnings: string[];
  statistics: RepositoryCleanupStatistics;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isUnsupportedResource(identifier: string): boolean {
  return identifier.endsWith(":unsupported");
}

function buildWarnings(skippedResources: readonly string[]): string[] {
  return skippedResources.map((resource) =>
    isUnsupportedResource(resource)
      ? `Skipped unsupported cleanup resource: ${resource}`
      : `Skipped cleanup resource: ${resource}`,
  );
}

export function buildRepositoryCleanupReport(
  execution: RepositoryCleanupExecutionReport,
): RepositoryCleanupReport {
  const executedResources = sortedUnique(execution.executedResourceIdentifiers);
  const skippedResources = sortedUnique(execution.skippedResourceIdentifiers);
  const totalExecuted = executedResources.length;
  const totalSkipped = skippedResources.length;
  const totalResources = totalExecuted + totalSkipped;
  const executionCoverage =
    totalResources === 0 ? 1 : round2(totalExecuted / totalResources);
  const completionPercentage = round2(executionCoverage * 100);
  const unsupportedResources = skippedResources.filter(isUnsupportedResource).length;

  return {
    repositoryId: execution.repositoryId,
    success: totalSkipped === 0,
    summary: {
      totalExecuted,
      totalSkipped,
    },
    executedResources,
    skippedResources,
    warnings: buildWarnings(skippedResources),
    statistics: {
      executionCoverage,
      unsupportedResources,
      completionPercentage,
    },
  };
}
