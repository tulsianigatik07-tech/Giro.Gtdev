import path from "node:path";

export const STORAGE_GUARD = ".storage/repos";
export const MAX_FILE_SIZE = 512 * 1024;
export const MAX_GREP_RESULTS = 100;
export const MAX_TREE_DEPTH = 6;

export function validateRepoPath(repoPath: string): void {
  if (!repoPath.includes(STORAGE_GUARD)) {
    throw new Error("Invalid repoPath: must be within .storage/repos");
  }
}

export function validateSafePath(repoPath: string, relativePath: string): string {
  const absolute = path.resolve(repoPath, relativePath);
  if (!absolute.startsWith(path.resolve(repoPath))) {
    throw new Error("Path traversal detected");
  }
  return absolute;
}
