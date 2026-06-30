import type { RetrievalCandidate } from "./candidateFilter.js";

export interface RetrievalContext {
  files: string[];
  content: string;
  chunkCount: number;
}

export function assembleRetrievalContext(
  candidates: readonly RetrievalCandidate[],
): RetrievalContext {
  const files = [...new Set(candidates.map((candidate) => candidate.filePath))];

  const content = candidates
    .map((candidate) => {
      return [
        `File: ${candidate.filePath}`,
        candidate.content,
      ].join("\n");
    })
    .join("\n\n---\n\n");

  return {
    files,
    content,
    chunkCount: candidates.length,
  };
}