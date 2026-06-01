import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateRepoPath, MAX_GREP_RESULTS } from "./validate.js";
import { shouldIgnorePath, shouldIgnoreFile } from "../repository/ignore.js";
import type { GrepMatch, GrepResult } from "./types.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function grepSearch(
  repoPath: string,
  query: string,
): Promise<GrepResult> {
  validateRepoPath(repoPath);
  const regex = new RegExp(escapeRegex(query), "i");
  const matches: GrepMatch[] = [];
  let truncated = false;
  const dirs: string[] = [repoPath];

  while (dirs.length > 0) {
    if (truncated) break;
    const dir = dirs.pop()!;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      if (truncated) break;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(repoPath, abs).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (!shouldIgnorePath(rel)) dirs.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldIgnorePath(rel) || shouldIgnoreFile(entry.name)) continue;

      let content: string;
      try { content = await readFile(abs, "utf-8"); } catch { continue; }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          matches.push({ filePath: rel, lineNumber: i + 1, matchedLine: lines[i]!.trim() });
          if (matches.length >= MAX_GREP_RESULTS) { truncated = true; break; }
        }
      }
    }
  }

  return { query, totalMatches: matches.length, truncated, matches };
}
