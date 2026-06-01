export interface EmbeddedChunk {
  repository: string;
  filePath: string;
  language: string;
  chunkIndex: number;
  content: string;
  summary: string | null;
  startLine: number;
  endLine: number;
  embedding: number[];
}

export interface SemanticSearchResult {
  repository: string;
  filePath: string;
  language: string;
  content: string;
  similarity: number;
  startLine: number;
  endLine: number;
}
