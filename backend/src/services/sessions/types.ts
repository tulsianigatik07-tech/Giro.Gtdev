// Types for the in-memory session memory layer.

export type MessageRole = "user" | "assistant";

export interface Citation {
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

// Compatible with the existing enriched retrieval chunk shape.
export interface SelectedContextChunk {
  filePath: string;
  language: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  source: string;
  signals: {
    semantic?: number;
    keyword?: number;
    symbol?: number;
    graph?: number;
    fileSearch?: number;
  };
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  citations: Citation[];
  createdAt: string; // ISO string
}

export interface Session {
  id: string;
  owner: string;
  repo: string;
  title: string;
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
  messages: Message[];
  selectedContext: SelectedContextChunk[];
}

export interface CreateSessionInput {
  owner: string;
  repo: string;
  title?: string;
}

export interface AddMessageInput {
  role: MessageRole;
  content: string;
  citations?: Citation[];
}

export interface SessionSummary {
  id: string;
  owner: string;
  repo: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
