import { listAllSessions } from "../sessions/sessionService.js";
import { getFileSymbolMaps } from "./graphSourceStore.js";
import { getRepositoryFileSnapshot } from "./fileSnapshotStore.js";
import { getRepositoryIndexMetadata } from "./indexingService.js";
import type { RepositoryIndexMetadata } from "./indexingTypes.js";
import { getRepositoryIntelligenceHistory } from "./repositoryIntelligenceHistory.js";
import { getRepositorySymbols } from "./symbolIndexStore.js";

export interface RepositoryCleanupResourceSection {
  exists: boolean;
  count: number;
  identifiers: string[];
  reason: string;
}

export interface RepositoryCleanupMetadataSection {
  exists: boolean;
  metadata: RepositoryIndexMetadata | null;
  reason: string;
}

export interface RepositoryCleanupUnsupportedSection {
  exists: false;
  count: 0;
  identifiers: [];
  supported: false;
  reason: string;
}

export interface RepositoryCleanupPlan {
  repository: {
    owner: string;
    repo: string;
    repoId: string;
  };
  cleanupRequired: boolean;
  totalResources: number;
  sections: {
    repositoryMetadata: RepositoryCleanupMetadataSection;
    fileSnapshots: RepositoryCleanupResourceSection;
    symbolRecords: RepositoryCleanupResourceSection;
    graphMetadata: RepositoryCleanupResourceSection;
    repositoryIntelligenceHistory: RepositoryCleanupResourceSection;
    cachedRetrievalArtifacts: RepositoryCleanupUnsupportedSection;
    sessionReferences: RepositoryCleanupResourceSection;
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function section(
  identifiers: readonly string[],
  presentReason: string,
  emptyReason: string,
): RepositoryCleanupResourceSection {
  const normalized = uniqueSorted(identifiers);
  return {
    exists: normalized.length > 0,
    count: normalized.length,
    identifiers: normalized,
    reason: normalized.length > 0 ? presentReason : emptyReason,
  };
}

function metadataSection(
  metadata: RepositoryIndexMetadata | null,
): RepositoryCleanupMetadataSection {
  return {
    exists: metadata !== null,
    metadata: metadata ? { ...metadata } : null,
    reason: metadata
      ? "repository metadata would be removed"
      : "no repository metadata found",
  };
}

export function buildRepositoryCleanupPlan(
  owner: string,
  repo: string,
): RepositoryCleanupPlan {
  const repoId = `${owner}/${repo}`;
  const metadata = getRepositoryIndexMetadata(owner, repo);
  const snapshot = getRepositoryFileSnapshot(repoId);
  const symbols = getRepositorySymbols(repoId);
  const graphMaps = getFileSymbolMaps(repoId);
  const intelligenceHistory = getRepositoryIntelligenceHistory(repoId);
  const sessions = listAllSessions().filter(
    (session) => session.owner === owner && session.repo === repo,
  );

  const repositoryMetadata = metadataSection(metadata);
  const fileSnapshots = section(
    snapshot?.files.map((file) => file.filePath) ?? [],
    "repository file snapshot entries would be removed",
    "no repository file snapshot found",
  );
  const symbolRecords = section(
    symbols.map(
      (symbol) =>
        `${symbol.filePath}:${symbol.startLine}:${symbol.endLine}:${symbol.kind}:${symbol.symbolName}`,
    ),
    "repository symbol records would be removed",
    "no repository symbol records found",
  );
  const graphMetadata = section(
    graphMaps.map((map) => map.filePath),
    "repository graph source metadata would be removed",
    "no repository graph source metadata found",
  );
  const repositoryIntelligenceHistory = section(
    intelligenceHistory.map((entry) => entry.generatedAt),
    "repository intelligence history entries would be removed",
    "no repository intelligence history found",
  );
  const cachedRetrievalArtifacts: RepositoryCleanupUnsupportedSection = {
    exists: false,
    count: 0,
    identifiers: [],
    supported: false,
    reason: "no repository-scoped retrieval artifact store is registered",
  };
  const sessionReferences = section(
    sessions.map((session) => session.id),
    "repository session references would be removed or detached",
    "no repository session references found",
  );

  const totalResources =
    (repositoryMetadata.exists ? 1 : 0) +
    fileSnapshots.count +
    symbolRecords.count +
    graphMetadata.count +
    repositoryIntelligenceHistory.count +
    cachedRetrievalArtifacts.count +
    sessionReferences.count;

  return {
    repository: { owner, repo, repoId },
    cleanupRequired: totalResources > 0,
    totalResources,
    sections: {
      repositoryMetadata,
      fileSnapshots,
      symbolRecords,
      graphMetadata,
      repositoryIntelligenceHistory,
      cachedRetrievalArtifacts,
      sessionReferences,
    },
  };
}
