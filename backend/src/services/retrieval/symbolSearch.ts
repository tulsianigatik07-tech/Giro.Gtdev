// Symbol-aware retrieval using extracted repository symbols. Read-only.

import { existsSync } from "node:fs";
import { logger } from "../../lib/logger.js";
import { repoClonePath } from "../repository/clone.js";
import { extractRepoSymbols } from "../graph/symbolExtractor.js";
import type { ExtractedSymbol } from "../graph/types.js";
import type { RetrievalResult } from "./types.js";

function tokenizeQuery(query: string): string[] {
  const tokens = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const t = raw.trim();
    if (!t) continue;
    tokens.add(t.toLowerCase());
    for (const part of t.split(/[_\-]/)) {
      if (part) tokens.add(part.toLowerCase());
    }
    for (const part of t.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/)) {
      if (part) tokens.add(part.toLowerCase());
    }
  }
  return [...tokens].filter((t) => t.length > 0);
}

function summarize(symbols: ExtractedSymbol[]): string {
  return (
    "Exports: " +
    symbols
      .slice(0, 10)
      .map((s) => `${s.kind} ${s.name} (line ${s.line})`)
      .join(", ")
  );
}

export async function symbolSearch(
  query: string,
  owner: string,
  repo: string,
  limit: number = 20,
): Promise<RetrievalResult[]> {
  const repository = `${owner}/${repo}`;
  const clonePath = repoClonePath(owner, repo);
  if (!existsSync(clonePath)) return [];

  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  try {
    const maps = await extractRepoSymbols(clonePath);

    const scored = maps
      .map((map) => {
        let raw = 0;
        const matched: ExtractedSymbol[] = [];
        for (const sym of map.symbols) {
          const name = sym.name.toLowerCase();
          let symScore = 0;
          if (tokens.includes(name)) symScore += 3.0;
          else if (tokens.some((t) => name.includes(t) || t.includes(name)))
            symScore += 1.5;
          if (symScore > 0) {
            if (sym.exported) symScore *= 1.5;
            raw += symScore;
            matched.push(sym);
          }
        }
        return { map, raw, matched };
      })
      .filter((s) => s.raw > 0);

    const maxRaw = scored.reduce((m, s) => (s.raw > m ? s.raw : m), 0) || 1;

    return scored
      .map((s) => {
        const score = Math.min(1, s.raw / maxRaw);
        const firstLine = s.matched[0]?.line ?? 1;
        const lastLine = s.matched[s.matched.length - 1]?.line ?? firstLine;
        return {
          repository,
          filePath: s.map.filePath,
          language: s.map.language,
          content: summarize(s.matched),
          startLine: firstLine,
          endLine: lastLine,
          score,
          source: "symbol" as const,
          signals: { symbol: score },
        };
      })
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.filePath.localeCompare(b.filePath) ||
          a.startLine - b.startLine,
      )
      .slice(0, limit);
  } catch (err) {
    logger.error("symbol_search_failed", {
      repository,
      message: err instanceof Error ? err.message : "unknown",
    });
    return [];
  }
}
