import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { validateRepoPath, validateSafePath } from "./validate.js";
import type { DirectoryEntry, DirectoryListing } from "./types.js";

export async function listDirectory(
  repoPath: string,
  relativePath: string = ".",
): Promise<DirectoryListing> {
  validateRepoPath(repoPath);
  const absolute = validateSafePath(repoPath, relativePath);
  const raw = await readdir(absolute, { withFileTypes: true });

  const entries: DirectoryEntry[] = [];
  for (const entry of raw) {
    const full = path.join(absolute, entry.name);
    let sizeBytes = 0;
    let modifiedAt = new Date(0).toISOString();
    try {
      const info = await stat(full);
      sizeBytes = entry.isDirectory() ? 0 : info.size;
      modifiedAt = info.mtime.toISOString();
    } catch { /* fallback defaults */ }
    entries.push({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      sizeBytes,
      modifiedAt,
    });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { path: relativePath, entries };
}
