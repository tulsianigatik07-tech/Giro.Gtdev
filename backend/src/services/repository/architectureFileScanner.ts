import fs from "node:fs";
import path from "node:path";
import { resolveRepositoryPathSync, type TrustedRepositoryCheckoutPath, type TrustedRepositoryFilePath } from "../security/repositoryPaths.js";

export function scanRepositoryFiles(
  rootDirectory: TrustedRepositoryCheckoutPath,
): TrustedRepositoryFilePath[] {
  const results: TrustedRepositoryFilePath[] = [];

  function walk(currentDirectory: string): void {
    const entries = fs.readdirSync(currentDirectory, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(
        currentDirectory,
        entry.name,
      );

      if (entry.isDirectory()) {
        const relative = path.relative(rootDirectory, fullPath);
        try { walk(resolveRepositoryPathSync(rootDirectory, relative, { requireDirectory: true })); } catch { /* skip unsafe/raced directory */ }
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        results.push(resolveRepositoryPathSync(rootDirectory, path.relative(rootDirectory, fullPath), { requireFile: true }));
      } catch { /* skip unsafe/raced file */ }
    }
  }

  walk(rootDirectory);

  return results;
}
