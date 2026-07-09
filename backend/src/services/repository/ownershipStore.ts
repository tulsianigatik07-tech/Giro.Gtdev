// Repository ownership compatibility API. Ownership is now backed by the
// repository store abstraction while preserving the historical synchronous
// set/get/clear surface used by routes and guards.

import { MemoryRepositoryStore } from "./store/memoryRepositoryStore.js";

const ownershipStore = new MemoryRepositoryStore();

function parseRepositoryId(repoId: string): { owner: string; repo: string } {
  const separator = repoId.indexOf("/");
  if (separator === -1) {
    return { owner: repoId, repo: "" };
  }

  return {
    owner: repoId.slice(0, separator),
    repo: repoId.slice(separator + 1),
  };
}

function normalizedRepositoryId(repoId: string): string {
  const { owner, repo } = parseRepositoryId(repoId);
  return `${owner}/${repo}`;
}

export function setRepositoryOwner(repoId: string, userId: string): void {
  const { owner, repo } = parseRepositoryId(repoId);
  ownershipStore.connectRepository({ owner, repo, ownerUserId: userId });
}

export function getRepositoryOwner(repoId: string): string | undefined {
  return ownershipStore.getRepository(normalizedRepositoryId(repoId))?.ownerUserId ?? undefined;
}

export function clearRepositoryOwners(): void {
  ownershipStore.clear();
}
