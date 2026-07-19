// Types for the in-memory session memory layer.

export type MessageRole = "user" | "assistant";

export interface Citation {
  filePath?: string;
  startLine: number;
  endLine: number;
  snippet?: string;
  repositoryId?: string;
  relativeFilePath?: string;
  language?: string;
  chunkId?: string;
  retrievalType?: "semantic" | "keyword" | "symbol" | "graph" | "hybrid" | "file-search";
  score?: number;
  symbol?: string;
  repositoryVersion?: string;
}

// Compatible with the existing enriched retrieval chunk shape. Older stored
// sessions may omit source and signal provenance, so those fields stay optional.
export interface SelectedContextChunk {
  filePath: string;
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  source?: string;
  signals?: {
    semantic?: number;
    keyword?: number;
    symbol?: number;
    graph?: number;
    fileSearch?: number;
  };
  chunkId?: string;
  symbol?: string;
  repositoryVersion?: string;
  citationRetrievalType?: "semantic" | "keyword" | "symbol" | "graph" | "hybrid" | "file-search";
}

export interface PersistedRetrievalMetadata {
  repositoryId: string;
  retrievedAt: string;
  sourceCounts: {
    semantic: number;
    keyword: number;
    symbol: number;
    graph: number;
    fileSearch: number;
  };
  estimatedContextTokens: number;
  selectedChunkCount: number;
  droppedChunkCount: number;
  confidence?: {
    level: "high" | "medium" | "low" | "insufficient";
    score: number;
    answerable: boolean;
    reasons: readonly string[];
  };
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  citations: Citation[];
  evidence?: SelectedContextChunk[];
  retrievalMetadata?: PersistedRetrievalMetadata;
  createdAt: string; // ISO string
}

export interface Session {
  id: string;
  userId: string;
  owner: string;
  repo: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  selectedContext: SelectedContextChunk[];
}

export interface CreateSessionInput {
  userId: string;
  owner: string;
  repo: string;
  title?: string;
}

export interface AddMessageInput {
  role: MessageRole;
  content: string;
  citations?: Citation[];
  evidence?: SelectedContextChunk[];
  retrievalMetadata?: PersistedRetrievalMetadata;
}

export interface SessionSummary {
  id: string;
  userId: string;
  owner: string;
  repo: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
