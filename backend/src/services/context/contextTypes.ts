// Upgraded context types for the hybrid + file-search assembly engine.

import type { ChunkConfidence } from "../retrieval/confidenceScorer.js";
import type { RetrievalDebugReport } from "../retrieval/debugReport.js";
import type { AnswerProvenance } from "../retrieval/answerProvenance.js";
import type { RetrievalExplainability } from "../retrieval/explainability.js";

export interface EnrichedContextChunk {
  filePath: string;
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  source: "semantic" | "keyword" | "symbol" | "graph" | "file-search";
  signals: {
    semantic?: number;
    keyword?: number;
    symbol?: number;
    graph?: number;
    fileSearch?: number;
  };
  reason?: string;
}

export interface EnrichedAssembledContext {
  query: string;
  repository: string;
  totalChunks: number;
  estimatedTokens: number;
  context: EnrichedContextChunk[];
  stats: {
    hybridResults: number;
    fileSearchResults: number;
    deduplicatedCount: number;
    finalCount: number;
    sourceCounts: {
      semantic: number;
      keyword: number;
      symbol: number;
      graph: number;
      fileSearch: number;
    };
    rerank?: {
      originalChunkCount: number;
      rerankedChunkCount: number;
      duplicateChunksRemoved: number;
      boostedChunkCount: number;
      crossFileBoostedChunkCount: number;
    };
    confidence?: number;
    chunkConfidence?: ChunkConfidence[];
    debugReport?: RetrievalDebugReport;
    answerProvenance?: AnswerProvenance;
    explainability?: RetrievalExplainability;
  };
}

export interface EnrichedAssemblyRequest {
  query: string;
  owner: string;
  repo: string;
  maxChars?: number;
  limit?: number;
}
