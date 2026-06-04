// Deterministic retrieval confidence scoring derived ONLY from a chunk's own
// signals. No AI, no randomness, no timestamps. Inputs are never mutated.

import type { EnrichedContextChunk } from "../context/contextTypes.js";

// Signal weights (sum = 1.0). Semantic similarity is the strongest evidence,
// followed by keyword, then structural (symbol/graph), then file-level search.
const WEIGHT_SEMANTIC = 0.35;
const WEIGHT_KEYWORD = 0.25;
const WEIGHT_SYMBOL = 0.15;
const WEIGHT_GRAPH = 0.15;
const WEIGHT_FILE_SEARCH = 0.1;

export interface ChunkConfidence {
  filePath: string;
  startLine: number;
  endLine: number;
  confidence: number;
  factors: {
    semantic: number;
    keyword: number;
    symbol: number;
    graph: number;
    fileSearch: number;
  };
}

export interface ContextConfidence {
  confidence: number;
  chunkCount: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function scoreChunkConfidence(chunk: EnrichedContextChunk): ChunkConfidence {
  const s = chunk.signals;
  const semantic = clamp01(s.semantic ?? 0);
  const keyword = clamp01(s.keyword ?? 0);
  const symbol = clamp01(s.symbol ?? 0);
  const graph = clamp01(s.graph ?? 0);
  const fileSearch = clamp01(s.fileSearch ?? 0);

  const weighted =
    semantic * WEIGHT_SEMANTIC +
    keyword * WEIGHT_KEYWORD +
    symbol * WEIGHT_SYMBOL +
    graph * WEIGHT_GRAPH +
    fileSearch * WEIGHT_FILE_SEARCH;

  return {
    filePath: chunk.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    confidence: round3(clamp01(weighted)),
    factors: {
      semantic: round3(semantic),
      keyword: round3(keyword),
      symbol: round3(symbol),
      graph: round3(graph),
      fileSearch: round3(fileSearch),
    },
  };
}

export function scoreContextConfidence(
  chunks: EnrichedContextChunk[],
): ContextConfidence {
  if (chunks.length === 0) {
    return { confidence: 0, chunkCount: 0 };
  }

  const sum = chunks.reduce(
    (acc, chunk) => acc + scoreChunkConfidence(chunk).confidence,
    0,
  );

  return {
    confidence: round3(sum / chunks.length),
    chunkCount: chunks.length,
  };
}
