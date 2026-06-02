// Deterministic merge + rerank across retrieval sources with graph + path signals.

import type { RetrievalResult, RetrievalSignals } from "./types.js";

const WEIGHTS = { semantic: 0.45, keyword: 0.25, symbol: 0.2, graph: 0.1 };

function keyOf(r: RetrievalResult): string {
  return `${r.filePath}:${r.startLine}-${r.endLine}`;
}

// Highest-signal source wins for content/source attribution.
function strongestSignal(s: RetrievalSignals): number {
  return Math.max(s.semantic ?? 0, s.keyword ?? 0, s.symbol ?? 0);
}

function pathMultiplier(filePath: string): number {
  const p = filePath.toLowerCase();
  // Penalties first (most specific / strongest suppression).
  if (p.includes("node_modules")) return 0.1;
  if (/\.(lock|lockb)$|lock\.json$/.test(p)) return 0.2;
  if (p.includes("/dist/") || p.startsWith("dist/") || /\.min\.(js|css)$/.test(p))
    return 0.3;
  if (p.includes("generated")) return 0.3;
  // Boosts.
  if (/(^|\/)(route|controller|handler)/.test(p)) return 1.3;
  if (/(^|\/)(service|lib|util)/.test(p)) return 1.2;
  if (/(^|\/)(index|main|app)\.(ts|js|tsx|jsx)$/.test(p)) return 1.2;
  if (/(^|\/)(config|env)\.(ts|js)$/.test(p)) return 1.1;
  return 1.0;
}

export function mergeAndRerank(
  results: RetrievalResult[],
  graphNodes: Map<string, number> | null,
  limit: number,
): RetrievalResult[] {
  const merged = new Map<string, RetrievalResult>();

  for (const r of results) {
    const key = keyOf(r);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...r, signals: { ...r.signals } });
      continue;
    }
    // Merge signals: keep the highest value per signal type.
    const sig = existing.signals;
    for (const k of ["semantic", "keyword", "symbol"] as const) {
      const incoming = r.signals[k];
      if (incoming !== undefined && incoming > (sig[k] ?? 0)) sig[k] = incoming;
    }
    // Keep content/source from the strongest contributing source.
    if (strongestSignal(r.signals) > strongestSignal(existing.signals)) {
      existing.content = r.content;
      existing.source = r.source;
    }
  }

  const out: RetrievalResult[] = [];
  for (const r of merged.values()) {
    if (graphNodes) {
      const centrality = graphNodes.get(r.filePath);
      if (centrality !== undefined) r.signals.graph = centrality;
    }
    const base =
      (r.signals.semantic ?? 0) * WEIGHTS.semantic +
      (r.signals.keyword ?? 0) * WEIGHTS.keyword +
      (r.signals.symbol ?? 0) * WEIGHTS.symbol +
      (r.signals.graph ?? 0) * WEIGHTS.graph;
    r.score = base * pathMultiplier(r.filePath);
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
