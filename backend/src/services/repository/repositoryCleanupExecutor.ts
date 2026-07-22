import { removeSession } from "../sessions/sessionService.js";
import { removeRepositoryGraphSource } from "./graphSourceStore.js";
import { removeRepositoryFileSnapshot } from "./fileSnapshotStore.js";
import { removeRepositoryIndexMetadata } from "./indexingService.js";
import { clearRepositoryIntelligenceHistory } from "./repositoryIntelligenceHistory.js";
import type { RepositoryCleanupPlan } from "./repositoryCleanupPlanner.js";
import { removeRepositorySymbols } from "./symbolIndexStore.js";

export interface RepositoryCleanupExecutionReport {
  repositoryId: string;
  executedResourceIdentifiers: string[];
  skippedResourceIdentifiers: string[];
  totalExecuted: number;
  totalSkipped: number;
}

export function describeRepositoryCleanupPlan(
  plan: RepositoryCleanupPlan,
): RepositoryCleanupExecutionReport {
  const executedResourceIdentifiers: string[] = [];
  const skippedResourceIdentifiers: string[] = [];
  const { repoId } = plan.repository;
  if (plan.sections.repositoryMetadata.exists) executedResourceIdentifiers.push(`repositoryMetadata:${repoId}`);
  if (plan.sections.fileSnapshots.exists) addExecuted(executedResourceIdentifiers, "fileSnapshots", plan.sections.fileSnapshots.identifiers);
  if (plan.sections.symbolRecords.exists) addExecuted(executedResourceIdentifiers, "symbolRecords", plan.sections.symbolRecords.identifiers);
  if (plan.sections.graphMetadata.exists) addExecuted(executedResourceIdentifiers, "graphMetadata", plan.sections.graphMetadata.identifiers);
  if (plan.sections.repositoryIntelligenceHistory.exists) addExecuted(executedResourceIdentifiers, "repositoryIntelligenceHistory", plan.sections.repositoryIntelligenceHistory.identifiers);
  if (!plan.sections.cachedRetrievalArtifacts.supported) skippedResourceIdentifiers.push("cachedRetrievalArtifacts:unsupported");
  if (plan.sections.sessionReferences.exists) addExecuted(executedResourceIdentifiers, "sessionReferences", plan.sections.sessionReferences.identifiers);
  executedResourceIdentifiers.sort((a, b) => a.localeCompare(b));
  skippedResourceIdentifiers.sort((a, b) => a.localeCompare(b));
  return {
    repositoryId: repoId,
    executedResourceIdentifiers,
    skippedResourceIdentifiers,
    totalExecuted: executedResourceIdentifiers.length,
    totalSkipped: skippedResourceIdentifiers.length,
  };
}

function prefixed(
  resource: string,
  identifiers: readonly string[],
): string[] {
  return identifiers
    .map((identifier) => `${resource}:${identifier}`)
    .sort((a, b) => a.localeCompare(b));
}

function addExecuted(
  executed: string[],
  resource: string,
  identifiers: readonly string[],
): void {
  executed.push(...prefixed(resource, identifiers));
}

export function executeRepositoryCleanupPlan(
  plan: RepositoryCleanupPlan,
): RepositoryCleanupExecutionReport {
  const { owner, repo, repoId } = plan.repository;
  const executedResourceIdentifiers: string[] = [];
  const skippedResourceIdentifiers: string[] = [];

  if (plan.sections.repositoryMetadata.exists) {
    removeRepositoryIndexMetadata(owner, repo);
    executedResourceIdentifiers.push(`repositoryMetadata:${repoId}`);
  }

  if (plan.sections.fileSnapshots.exists) {
    removeRepositoryFileSnapshot(repoId);
    addExecuted(
      executedResourceIdentifiers,
      "fileSnapshots",
      plan.sections.fileSnapshots.identifiers,
    );
  }

  if (plan.sections.symbolRecords.exists) {
    removeRepositorySymbols(repoId);
    addExecuted(
      executedResourceIdentifiers,
      "symbolRecords",
      plan.sections.symbolRecords.identifiers,
    );
  }

  if (plan.sections.graphMetadata.exists) {
    removeRepositoryGraphSource(repoId);
    addExecuted(
      executedResourceIdentifiers,
      "graphMetadata",
      plan.sections.graphMetadata.identifiers,
    );
  }

  if (plan.sections.repositoryIntelligenceHistory.exists) {
    clearRepositoryIntelligenceHistory(repoId);
    addExecuted(
      executedResourceIdentifiers,
      "repositoryIntelligenceHistory",
      plan.sections.repositoryIntelligenceHistory.identifiers,
    );
  }

  if (!plan.sections.cachedRetrievalArtifacts.supported) {
    skippedResourceIdentifiers.push("cachedRetrievalArtifacts:unsupported");
  }

  if (plan.sections.sessionReferences.exists) {
    for (const sessionId of [...plan.sections.sessionReferences.identifiers].sort(
      (a, b) => a.localeCompare(b),
    )) {
      removeSession(sessionId);
    }
    addExecuted(
      executedResourceIdentifiers,
      "sessionReferences",
      plan.sections.sessionReferences.identifiers,
    );
  }

  executedResourceIdentifiers.sort((a, b) => a.localeCompare(b));
  skippedResourceIdentifiers.sort((a, b) => a.localeCompare(b));

  return {
    repositoryId: repoId,
    executedResourceIdentifiers,
    skippedResourceIdentifiers,
    totalExecuted: executedResourceIdentifiers.length,
    totalSkipped: skippedResourceIdentifiers.length,
  };
}
