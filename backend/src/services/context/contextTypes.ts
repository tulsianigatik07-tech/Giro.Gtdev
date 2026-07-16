// Upgraded context types for the hybrid + file-search assembly engine.

import type { ChunkConfidence } from "../retrieval/confidenceScorer.js";
import type { RetrievalDebugReport } from "../retrieval/debugReport.js";
import type { AnswerProvenance } from "../retrieval/answerProvenance.js";
import type { RetrievalExplainability } from "../retrieval/explainability.js";
import type { RepositoryCoverage } from "../retrieval/repositoryCoverage.js";
import type { RetrievalHotspots } from "../retrieval/retrievalHotspots.js";
import type { RetrievalDiversity } from "../retrieval/retrievalDiversity.js";
import type { RetrievalBlindSpots } from "../retrieval/retrievalBlindSpots.js";
import type { RetrievalQualityScore } from "../retrieval/retrievalQualityScore.js";
import type { Citation, CitationRetrievalType } from "../retrieval/citations.js";
import type { PublicRetrievalConfidence } from "../retrieval/confidence/confidenceTypes.js";

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
  chunkId?: string;
  symbol?: string;
  repositoryVersion?: string;
  citationRetrievalType?: CitationRetrievalType;
  primaryQueryMatch?: boolean;
  queryExpansionMatch?: boolean;
  stitchedNeighborCount?: number;
}

export interface EnrichedAssembledContext {
  query: string;
  repository: string;
  totalChunks: number;
  estimatedTokens: number;
  context: EnrichedContextChunk[];
  citations?: Citation[];
  confidence?: PublicRetrievalConfidence;
  /** Internal carry-forward for post-token-budget confidence evaluation. */
  _confidenceBudgetDropCount?: number;
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
    repositoryCoverage?: RepositoryCoverage;
    retrievalHotspots?: RetrievalHotspots;
    retrievalDiversity?: RetrievalDiversity;
    retrievalBlindSpots?: RetrievalBlindSpots;
    retrievalQualityScore?: RetrievalQualityScore;
  };
}

export interface EnrichedAssemblyRequest {
  query: string;
  owner: string;
  repo: string;
  maxChars?: number;
  limit?: number;
}
