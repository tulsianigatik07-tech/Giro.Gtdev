// Types for the deterministic hybrid retrieval engine.

export type RetrievalSource = "semantic" | "keyword" | "symbol" | "graph";

export interface RetrievalSignals {
  semantic?: number;
  keyword?: number;
  symbol?: number;
  graph?: number;
}

export interface RetrievalResult {
  repository: string;
  filePath: string;
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  source: RetrievalSource;
  signals: RetrievalSignals;
}

export interface HybridSearchRequest {
  query: string;
  owner: string;
  repo: string;
  limit?: number;
}

export interface HybridSearchResponse {
  query: string;
  repository: string;
  results: RetrievalResult[];
  stats: {
    semanticResults: number;
    keywordResults: number;
    symbolResults: number;
    graphBoosted: number;
    returned: number;
  };
}
