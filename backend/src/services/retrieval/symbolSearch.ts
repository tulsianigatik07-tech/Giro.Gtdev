// Symbol-aware retrieval using extracted repository symbols. Read-only.

import { logger } from "../../lib/logger.js";
import { getRepositorySymbolGraph } from "../repositoryGraph/runtimeRepositoryGraph.js";
import type { RepositoryGraphNode } from "../repositoryGraph/graphTypes.js";
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

function summarize(symbols: RepositoryGraphNode[]): string {
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
  options: { repositoryVersion?: string } = {},
): Promise<RetrievalResult[]> {
  const repository = `${owner}/${repo}`;
  const graph = getRepositorySymbolGraph(repository);
  if (!graph || !options.repositoryVersion || graph.repositoryVersion !== options.repositoryVersion) return [];

  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  try {
    const maps = new Map<string, RepositoryGraphNode[]>();
    for (const node of graph.nodes) {
      if (node.kind === "module" || node.kind === "imported_member") continue;
      const nodes = maps.get(node.file) ?? [];
      nodes.push(node);
      maps.set(node.file, nodes);
    }

    const scored = [...maps.entries()]
      .map(([filePath, symbols]) => {
        let raw = 0;
        const matched: RepositoryGraphNode[] = [];
        for (const sym of symbols) {
          const name = sym.name.toLowerCase();
          let symScore = 0;
          if (tokens.includes(name)) symScore += 3.0;
          else if (tokens.some((t) => name.includes(t) || t.includes(name)))
            symScore += 1.5;
          if (symScore > 0) {
            raw += symScore;
            matched.push(sym);
          }
        }
        return { filePath, raw, matched };
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
          filePath: s.filePath,
          language: s.matched[0]?.language ?? "unknown",
          content: summarize(s.matched),
          startLine: firstLine,
          endLine: lastLine,
          score,
          source: "symbol" as const,
          signals: { symbol: score },
          symbol: s.matched[0]?.name,
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
