import { readdir } from "node:fs/promises";
import path from "node:path";
import { MAX_TREE_DEPTH } from "./validate.js";
import type { TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";
import { resolveRepositoryPath } from "../security/repositoryPaths.js";
import { shouldIgnorePath, shouldIgnoreFile } from "../repository/ignore.js";
import type { FileTreeNode } from "./types.js";

export async function buildFileTree(repoPath: TrustedRepositoryCheckoutPath): Promise<FileTreeNode> {

  async function buildNode(absPath: string, relPath: string, depth: number): Promise<FileTreeNode> {
    const name = path.basename(absPath);
    if (depth > MAX_TREE_DEPTH) return { name, type: "directory", children: [] };

    let entries;
    try { entries = await readdir(absPath, { withFileTypes: true }); } catch {
      return { name, type: "directory", children: [] };
    }

    const children: FileTreeNode[] = [];
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of sorted) {
      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      if (shouldIgnorePath(entryRel) || shouldIgnoreFile(entry.name)) continue;
      if (entry.isDirectory()) {
        try {
          const safeDirectory = await resolveRepositoryPath(repoPath, entryRel, { mustExist: true, requireDirectory: true });
          children.push(await buildNode(safeDirectory, entryRel, depth + 1));
        } catch { /* skip unsafe/raced directories */ }
      } else {
        if (!entry.isFile()) continue;
        children.push({ name: entry.name, type: "file" });
      }
    }

    return { name, type: "directory", children };
  }

  return buildNode(repoPath, "", 0);
}
