export interface RepositoryIndexRegistryEntry {
  repositoryId: string;
  owner: string;
  repo: string;
  status: string;
  indexedAt: string | null;
  lastAccessed: string | null;
  ready: boolean;
  metadataAvailable: boolean;
  symbolCount: number;
  fileCount: number;
  graphAvailable: boolean;
  health: string;
}

const repositories = new Map<string, RepositoryIndexRegistryEntry>();

function copyRepository(
  repository: RepositoryIndexRegistryEntry,
): RepositoryIndexRegistryEntry {
  return {
    repositoryId: repository.repositoryId,
    owner: repository.owner,
    repo: repository.repo,
    status: repository.status,
    indexedAt: repository.indexedAt,
    lastAccessed: repository.lastAccessed,
    ready: repository.ready,
    metadataAvailable: repository.metadataAvailable,
    symbolCount: repository.symbolCount,
    fileCount: repository.fileCount,
    graphAvailable: repository.graphAvailable,
    health: repository.health,
  };
}

export function registerRepository(
  repository: RepositoryIndexRegistryEntry,
): RepositoryIndexRegistryEntry {
  const snapshot = copyRepository(repository);
  repositories.set(snapshot.repositoryId, snapshot);
  return copyRepository(snapshot);
}

export function removeRepository(repositoryId: string): void {
  repositories.delete(repositoryId);
}

export function getRepository(
  repositoryId: string,
): RepositoryIndexRegistryEntry | null {
  const repository = repositories.get(repositoryId);
  return repository ? copyRepository(repository) : null;
}

export function listRepositories(): RepositoryIndexRegistryEntry[] {
  return [...repositories.values()]
    .map(copyRepository)
    .sort((a, b) => a.repositoryId.localeCompare(b.repositoryId));
}

export function repositoryExists(repositoryId: string): boolean {
  return repositories.has(repositoryId);
}

export function repositoryCount(): number {
  return repositories.size;
}

export function clearRepositoryRegistry(): void {
  repositories.clear();
}
