// Deterministic retrieval explainability: human-readable labels explaining WHY
// each chunk was retrieved. Metadata ONLY — never affects ranking, reranking,
// confidence, selection, budgeting, or answer generation. No AI, no scores, no
// timestamps, no randomness. Inputs are never mutated.

import type { EnrichedContextChunk } from "../context/contextTypes.js";

export interface ChunkExplanation {
  filePath: string;
  startLine: number;
  endLine: number;
  reasons: string[];
}

export interface RetrievalExplainability {
  chunks: ChunkExplanation[];
}

// Source-derived label mapping. Only real source literals with a defensible
// target are mapped; sources without a defined mapping are omitted (never
// invented). The signal-based labels already cover every retrieval path.
const SOURCE_LABELS: Partial<Record<EnrichedContextChunk["source"], string>> = {
  graph: "dependency-source",
};

function reasonsForChunk(chunk: EnrichedContextChunk): string[] {
  const labels = new Set<string>();
  const s = chunk.signals;

  if ((s.semantic ?? 0) > 0) labels.add("semantic-match");
  if ((s.keyword ?? 0) > 0) labels.add("keyword-match");
  if ((s.symbol ?? 0) > 0) labels.add("symbol-match");
  if ((s.graph ?? 0) > 0) labels.add("graph-match");
  if ((s.fileSearch ?? 0) > 0) labels.add("file-search-match");

  const sourceLabel = SOURCE_LABELS[chunk.source];
  if (sourceLabel !== undefined) labels.add(sourceLabel);

  // Deduplicated (Set) + alphabetically sorted ascending.
  return [...labels].sort((a, b) => a.localeCompare(b));
}

export function buildRetrievalExplainability(
  chunks: EnrichedContextChunk[],
): RetrievalExplainability {
  return {
    chunks: chunks.map((chunk) => ({
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      reasons: reasonsForChunk(chunk),
    })),
  };
}
