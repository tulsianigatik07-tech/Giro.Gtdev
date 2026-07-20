import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";
import { resolveRepositoryPath } from "../security/repositoryPaths.js";
import { shouldIgnorePath, shouldIgnoreFile } from "../repository/ignore.js";
import type { SymbolMatch } from "./types.js";

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  ".ts": [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /(?:export\s+)?class\s+(\w+)/,
    /(?:export\s+)?interface\s+(\w+)/,
    /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/,
    /(?:export\s+)?type\s+(\w+)\s*=/,
  ],
  ".js": [
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /(?:module\.exports\s*=\s*)?(?:const|let|var)\s+(\w+)\s*=/,
  ],
  ".py": [/^def\s+(\w+)/, /^class\s+(\w+)/],
  ".go": [/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/, /^type\s+(\w+)/],
};
SYMBOL_PATTERNS[".tsx"] = SYMBOL_PATTERNS[".ts"]!;

export async function findSymbol(
  repoPath: TrustedRepositoryCheckoutPath,
  symbol: string,
): Promise<SymbolMatch[]> {
  const matches: SymbolMatch[] = [];
  const lowerSymbol = symbol.toLowerCase();
  const dirs: string[] = [repoPath];

  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(repoPath, abs).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (!shouldIgnorePath(rel)) {
          try { dirs.push(await resolveRepositoryPath(repoPath, rel, { mustExist: true, requireDirectory: true })); } catch { /* skip unsafe/raced directories */ }
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const patterns = SYMBOL_PATTERNS[ext];
      if (!patterns) continue;
      if (shouldIgnorePath(rel) || shouldIgnoreFile(entry.name)) continue;

      let content: string;
      try {
        const safeFile = await resolveRepositoryPath(repoPath, rel, { mustExist: true, requireFile: true });
        content = await readFile(safeFile, "utf-8");
      } catch { continue; }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const pat of patterns) {
          const m = pat.exec(lines[i]!);
          const captured = m?.[1] ?? m?.[2];
          if (captured && captured.toLowerCase().includes(lowerSymbol)) {
            matches.push({
              symbol: captured,
              filePath: rel,
              lineNumber: i + 1,
              matchedLine: lines[i]!.trim().slice(0, 120),
            });
          }
        }
      }
    }
  }

  return matches.sort((a, b) =>
    a.filePath === b.filePath ? a.lineNumber - b.lineNumber : a.filePath.localeCompare(b.filePath),
  );
}
