import { buildRepositoryStatusSnapshot } from "./repositoryStatusSnapshot.js";
import { getRepositoryIndexMetadata } from "./indexingService.js";

export interface RepositoryDashboardSummary {
  repository: string;
  status: ReturnType<typeof buildRepositoryStatusSnapshot>;
  metrics: {
    files: number;
    chunks: number;
    symbols: number;
    graphNodes: number;
    graphEdges: number;
  };
}

export function buildRepositoryDashboardSummary(
  owner: string,
  repo: string,
): RepositoryDashboardSummary {
  const metadata = getRepositoryIndexMetadata(owner, repo);

  return {
    repository: `${owner}/${repo}`,
    status: buildRepositoryStatusSnapshot(owner, repo),
    metrics: {
      files: metadata?.fileCount ?? 0,
      chunks: metadata?.chunkCount ?? 0,
      symbols: metadata?.symbolCount ?? 0,
      graphNodes: metadata?.graphNodeCount ?? 0,
      graphEdges: metadata?.graphEdgeCount ?? 0,
    },
  };
}