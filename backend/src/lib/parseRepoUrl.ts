// Parses a GitHub repository reference into { owner, repo }.
// Accepts full URLs, github.com/owner/repo, and bare owner/repo.

import { normalizeGitHubRepositoryReference } from "../services/security/repositoryIdentity.js";

export interface ParsedRepo {
  owner: string;
  repo: string;
}

export function parseRepoUrl(url: string): ParsedRepo {
  const { owner, repo } = normalizeGitHubRepositoryReference(url);
  return { owner, repo };
}
