// Deterministic merge + rerank across retrieval sources with graph + path signals.

import type { RetrievalResult, RetrievalSignals } from "./types.js";

export interface RerankingWeights {
  semantic: number;
  keyword: number;
  symbol: number;
  graph: number;
}

export const DEFAULT_RERANKING_WEIGHTS: RerankingWeights = {
  semantic: 0.45,
  keyword: 0.25,
  symbol: 0.2,
  graph: 0.1,
};

function keyOf(result: RetrievalResult): string {
  return `${result.filePath}:${result.startLine}-${result.endLine}`;
}

function strongestSignal(signals: RetrievalSignals): number {
  return Math.max(
    signals.semantic ?? 0,
    signals.keyword ?? 0,
    signals.symbol ?? 0,
  );
}

function pathMultiplier(filePath: string): number {
  const path = filePath.toLowerCase();

  if (path.includes("node_modules")) return 0.1;
  if (/\.(lock|lockb)$|lock\.json$/.test(path)) return 0.2;

  if (
    path.includes("/dist/") ||
    path.startsWith("dist/") ||
    /\.min\.(js|css)$/.test(path)
  ) {
    return 0.3;
  }

  if (path.includes("generated")) return 0.3;

  if (/(^|\/)(route|controller|handler)/.test(path)) return 1.3;
  if (/(^|\/)(service|lib|util)/.test(path)) return 1.2;
  if (/(^|\/)(index|main|app)\.(ts|js|tsx|jsx)$/.test(path)) return 1.2;
  if (/(^|\/)(config|env)\.(ts|js)$/.test(path)) return 1.1;

  return 1.0;
}

function contentMultiplier(content: string): number {
  const length = content.length;

  if (length > 2000) return 1.15;
  if (length > 1000) return 1.1;
  if (length > 500) return 1.05;
  if (length < 100) return 0.9;

  return 1.0;
}

export function calculateRerankScore(
  signals: RetrievalSignals,
  filePath: string,
  content: string,
  weights: RerankingWeights = DEFAULT_RERANKING_WEIGHTS,
): number {
  const base =
    (signals.semantic ?? 0) * weights.semantic +
    (signals.keyword ?? 0) * weights.keyword +
    (signals.symbol ?? 0) * weights.symbol +
    (signals.graph ?? 0) * weights.graph;

  return base * pathMultiplier(filePath) * contentMultiplier(content);
}

export function mergeAndRerank(
  results: RetrievalResult[],
  graphNodes: Map<string, number> | null,
  limit: number,
  weights: RerankingWeights = DEFAULT_RERANKING_WEIGHTS,
): RetrievalResult[] {
  const merged = new Map<string, RetrievalResult>();

  for (const result of results) {
    const key = keyOf(result);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, { ...result, signals: { ...result.signals } });
      continue;
    }

    const signals = existing.signals;

    for (const key of ["semantic", "keyword", "symbol"] as const) {
      const incoming = result.signals[key];

      if (incoming !== undefined && incoming > (signals[key] ?? 0)) {
        signals[key] = incoming;
      }
    }

    if (strongestSignal(result.signals) > strongestSignal(existing.signals)) {
      existing.content = result.content;
      existing.source = result.source;
    }
  }

  const output: RetrievalResult[] = [];

  for (const result of merged.values()) {
    if (graphNodes) {
      const centrality = graphNodes.get(result.filePath);

      if (centrality !== undefined) {
        result.signals.graph = centrality;
      }
    }

    result.score = calculateRerankScore(
      result.signals,
      result.filePath,
      result.content,
      weights,
    );

    output.push(result);
  }

  return output
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine,
    )
    .slice(0, limit);
}