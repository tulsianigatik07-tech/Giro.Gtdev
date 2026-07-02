import type { RetrievalCandidate } from "./candidateFilter.js";

export interface RetrievalChunk {
  filePath: string;
  content: string;
  score?: number;
}

export function mapChunksToCandidates(
  chunks: readonly RetrievalChunk[],
): RetrievalCandidate[] {
  return chunks.map((chunk) => ({
    filePath: chunk.filePath,
    content: chunk.content,
    score: chunk.score ?? 0,
  }));
}