const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;

export type RepositoryIdentity = Readonly<{
  repositoryId: string;
  owner: string;
  repo: string;
}>;

export class RepositoryIdentityError extends Error {
  readonly reasonCode: "malformed_repository_identity";

  constructor(message = "Repository identity is invalid.") {
    super(message);
    this.name = "RepositoryIdentityError";
    this.reasonCode = "malformed_repository_identity";
  }
}

function validateSegment(value: string, kind: "owner" | "repository"): string {
  if (
    CONTROL_CHARACTERS.test(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    ENCODED_PATH_SEPARATOR.test(value)
  ) {
    throw new RepositoryIdentityError();
  }
  const pattern = kind === "owner" ? OWNER_PATTERN : REPOSITORY_PATTERN;
  if (!pattern.test(value)) throw new RepositoryIdentityError();
  return value;
}

/**
 * Repository owner/name casing is intentionally preserved. Giro's existing
 * durable repository IDs are case-sensitive, so folding case here could merge
 * two existing records. Every accepted representation still flows through
 * this single parser.
 */
export function normalizeRepositoryParts(ownerInput: string, repoInput: string): RepositoryIdentity {
  const owner = validateSegment(ownerInput.trim(), "owner");
  const repo = validateSegment(repoInput.trim(), "repository");
  return Object.freeze({ repositoryId: `${owner}/${repo}`, owner, repo });
}

export function normalizeRepositoryId(input: string): RepositoryIdentity {
  const value = input.trim();
  if (CONTROL_CHARACTERS.test(value) || ENCODED_PATH_SEPARATOR.test(value)) {
    throw new RepositoryIdentityError();
  }
  const parts = value.split("/");
  if (parts.length !== 2) throw new RepositoryIdentityError();
  return normalizeRepositoryParts(parts[0] ?? "", parts[1] ?? "");
}

export function normalizeGitHubRepositoryReference(input: string): RepositoryIdentity {
  const raw = input.trim();
  if (!raw || CONTROL_CHARACTERS.test(raw) || ENCODED_PATH_SEPARATOR.test(raw)) {
    throw new RepositoryIdentityError("Repository URL is invalid.");
  }

  let repositoryPath: string;
  const ssh = /^git@([^:]+):(.+)$/i.exec(raw);
  if (ssh) {
    if ((ssh[1] ?? "").toLowerCase() !== "github.com") throw new RepositoryIdentityError("Repository URL is invalid.");
    if (!(ssh[2] ?? "").endsWith(".git")) throw new RepositoryIdentityError("Repository URL is invalid.");
    repositoryPath = ssh[2] ?? "";
  } else if (/^https?:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new RepositoryIdentityError("Repository URL is invalid.");
    }
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
      throw new RepositoryIdentityError("Repository URL is invalid.");
    }
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
      throw new RepositoryIdentityError("Repository URL is invalid.");
    }
    repositoryPath = parsed.pathname;
  } else {
    repositoryPath = raw.replace(/^github\.com\//i, "");
  }

  const trimmed = repositoryPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (ENCODED_PATH_SEPARATOR.test(trimmed)) throw new RepositoryIdentityError("Repository URL is invalid.");
  const parts = trimmed.split("/");
  if (parts.length !== 2) throw new RepositoryIdentityError("Repository URL is invalid.");
  return normalizeRepositoryParts(parts[0] ?? "", parts[1] ?? "");
}
