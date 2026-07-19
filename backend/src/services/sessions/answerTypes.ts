// Types for the deterministic answer synthesis layer.

import type { Citation } from "../retrieval/citations.js";
import type { PublicRetrievalConfidence } from "../retrieval/confidence/confidenceTypes.js";

export interface AnswerSource {
  path: string;
  reason: string;
  score: number;
}

export interface AskMetadata {
  retrievedFiles: number;
  usedSummary: boolean;
  usedDependencyGraph: boolean;
  retrievalSourceCounts: {
    semantic: number;
    keyword: number;
    symbol: number;
    graph: number;
    fileSearch: number;
  };
  estimatedContextTokens: number;
  confidence?: PublicRetrievalConfidence;
}

export interface AskResult {
  answer: string;
  sources: AnswerSource[];
  citations: Citation[];
  metadata: AskMetadata;
  retrieval: {
    query: string;
    repository: string;
    results: Array<{
      repository: string;
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
      chunkId?: string;
      symbol?: string;
    }>;
    citations: Citation[];
    stats: {
      semanticResults: number;
      keywordResults: number;
      symbolResults: number;
      graphBoosted: number;
      returned: number;
    };
  };
}

export interface RepositorySummaryView {
  framework: string;
  primaryLanguage: string;
  entrypoints: string[];
  centralModules: string[];
  available: boolean;
}
