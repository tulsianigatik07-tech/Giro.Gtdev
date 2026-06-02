// Types for the deterministic file-level semantic search engine.

export interface FileSearchResult {
  path: string;
  score: number;
  reason: string;
  symbols: string[];
  language: string;
}

export interface FileSearchRequest {
  query: string;
  owner: string;
  repo: string;
  limit?: number;
}

export interface FileSearchResponse {
  query: string;
  repository: string;
  results: FileSearchResult[];
  totalFilesScanned: number;
}

export interface ScoringSignals {
  filenameMatch: number;
  symbolMatch: number;
  directoryImportance: number;
  keywordOverlap: number;
  centralityBoost: number;
}
