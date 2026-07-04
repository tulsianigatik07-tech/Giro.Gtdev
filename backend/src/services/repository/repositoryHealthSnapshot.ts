import { getRepositoryIndexMetadata } from "./indexingService.js";

export interface RepositoryHealthSnapshot {
  repository: string;
  indexed: boolean;
  healthy: boolean;
  stale: boolean;
  status: string;
  lastIndexedAt: string | null;
  lastAccessedAt: string | null;
}

export function buildRepositoryHealthSnapshot(
  owner: string,
  repo: string,
): RepositoryHealthSnapshot {
  const metadata = getRepositoryIndexMetadata(owner, repo);

  if (!metadata) {
    return {
      repository: `${owner}/${repo}`,
      indexed: false,
      healthy: false,
      stale: false,
      status: "missing",
      lastIndexedAt: null,
      lastAccessedAt: null,
    };
  }

  return {
    repository: `${owner}/${repo}`,
    indexed: metadata.status === "indexed",
    healthy: metadata.status === "indexed",
    stale: metadata.status === "stale",
    status: metadata.status,
    lastIndexedAt: metadata.lastIndexedAt,
    lastAccessedAt: metadata.lastAccessedAt,
  };
}