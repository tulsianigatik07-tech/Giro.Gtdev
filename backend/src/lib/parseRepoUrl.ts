// Parses a GitHub repository reference into { owner, repo }.
// Accepts full URLs, github.com/owner/repo, and bare owner/repo.

export interface ParsedRepo {
  owner: string;
  repo: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function parseRepoUrl(url: string): ParsedRepo {
  const raw = url.trim();
  if (!raw) throw new Error("Repository URL is empty");

  let cleaned = raw
    .replace(/^git@github\.com:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

  // If a full github.com URL was passed without protocol stripping above.
  cleaned = cleaned.replace(/^github\.com\//, "");

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new Error(`Invalid GitHub repository URL: ${url}`);
  }

  const [owner, repo] = parts as [string, string];
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    throw new Error(`Invalid GitHub repository URL: ${url}`);
  }

  return { owner, repo };
}
