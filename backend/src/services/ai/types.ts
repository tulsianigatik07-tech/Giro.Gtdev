// Types for the repository-aware AI chat engine.

export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
}

export interface ChatRequest {
  query: string;
}

export interface ChatChunk {
  content: string;
}

export interface ChatResponse {
  answer: string;
  citations: Citation[];
  totalChunks: number;
  estimatedTokens: number;
}
