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

function keyOf(r: RetrievalResult): string {
  return `${r.filePath}:${r.startLine}-${r.endLine}`;
}

function strongestSignal(s: RetrievalSignals): number {
  return Math.max(s.semantic ?? 0, s.keyword ?? 0, s.symbol ?? 0);
}

function pathMultiplier(filePath: string): number {
  const p = filePath.toLowerCase();

  if (p.includes("node_modules")) return 0.1;
  if (/\.(lock|lockb)$|lock\.json$/.test(p)) return 0.2;
  if (p.includes("/dist/") || p.startsWith("dist/") || /\.min\.(js|css)$/.test(p)) {
    return 0.3;
  }
  if (p.includes("generated")) return 0.3;

  if (/(^|\/)(route|controller|handler)/.test(p)) return 1.3;
  if (/(^|\/)(service|lib|util)/.test(p)) return 1.2;
  if (/(^|\/)(index|main|app)\.(ts|js|tsx|jsx)$/.test(p)) return 1.2;
  if (/(^|\/)(config|env)\.(ts|js)$/.test(p)) return 1.1;

  return 1.0;
}

export function calculateRerankScore(
  signals: RetrievalSignals,
  filePath: string,
  weights: RerankingWeights = DEFAULT_RERANKING_WEIGHTS,
): number {
  const base =
    (signals.semantic ?? 0) * weights.semantic +
    (signals.keyword ?? 0) * weights.keyword +
    (signals.symbol ?? 0) * weights.symbol +
    (signals.graph ?? 0) * weights.graph;

  return base * pathMultiplier(filePath);
}

export function mergeAndRerank(
  results: RetrievalResult[],
  graphNodes: Map<string, number> | null,
  limit: number,
  weights: RerankingWeights = DEFAULT_RERANKING_WEIGHTS,
): RetrievalResult[] {
  const merged = new Map<string, RetrievalResult>();

  for (const r of results) {
    const key = keyOf(r);
    const existing = merged.get(key);

    if (!existing) {
      merged.set(key, { ...r, signals: { ...r.signals } });
      continue;
    }

    const sig = existing.signals;

    for (const k of ["semantic", "keyword", "symbol"] as const) {
      const incoming = r.signals[k];

      if (incoming !== undefined && incoming > (sig[k] ?? 0)) {
        sig[k] = incoming;
      }
    }

    if (strongestSignal(r.signals) > strongestSignal(existing.signals)) {
      existing.content = r.content;
      existing.source = r.source;
    }
  }

  const out: RetrievalResult[] = [];

  for (const r of merged.values()) {
    if (graphNodes) {
      const centrality = graphNodes.get(r.filePath);

      if (centrality !== undefined) {
        r.signals.graph = centrality;
      }
    }

    r.score = calculateRerankScore(r.signals, r.filePath, weights);
    out.push(r);
  }

  return out
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine,
    )
    .slice(0, limit);
}