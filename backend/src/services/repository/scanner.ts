// Walks a cloned repository and produces aggregate stats + a top-level tree.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { shouldIgnoreFile, shouldIgnorePath, IGNORED_DIRS } from "./ignore.js";
import { resolveRepositoryPath, type TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";

const MAX_FILE_SIZE = 512 * 1024;

export interface ScannedFile {
  filePath: string;
  size: number;
  language: string;
}

export interface ScanStats {
  totalFiles: number;
  totalDirectories: number;
  languages: Record<string, number>;
  tree: string[];
  files: ScannedFile[];
}

export async function scanRepo(clonePath: TrustedRepositoryCheckoutPath): Promise<ScanStats> {
  const languages: Record<string, number> = {};
  const files: ScannedFile[] = [];
  let totalFiles = 0;
  let totalDirectories = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(clonePath, full);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        totalDirectories += 1;
        try {
          await walk(await resolveRepositoryPath(clonePath, rel, { mustExist: true, requireDirectory: true }));
        } catch { /* skip unsafe or raced directories */ }
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldIgnorePath(rel) || shouldIgnoreFile(entry.name)) continue;

      const safeFile = await resolveRepositoryPath(clonePath, rel, { mustExist: true, requireFile: true });
      const info = await stat(safeFile);
      if (info.size > MAX_FILE_SIZE) continue;

      totalFiles += 1;
      const ext = path.extname(entry.name).toLowerCase() || "none";
      languages[ext] = (languages[ext] ?? 0) + 1;
      files.push({ filePath: rel, size: info.size, language: ext });
    }
  }

  await walk(clonePath);
  const tree = await buildTree(clonePath);

  files.sort((a, b) => a.filePath.localeCompare(b.filePath));

  return { totalFiles, totalDirectories, languages, tree, files };
}

async function buildTree(clonePath: string): Promise<string[]> {
  const entries = await readdir(clonePath, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== ".git" && !e.isSymbolicLink())
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => a.localeCompare(b));
}
