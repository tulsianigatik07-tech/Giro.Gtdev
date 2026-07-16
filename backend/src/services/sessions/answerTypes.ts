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
}

export interface RepositorySummaryView {
  framework: string;
  primaryLanguage: string;
  entrypoints: string[];
  centralModules: string[];
  available: boolean;
}
