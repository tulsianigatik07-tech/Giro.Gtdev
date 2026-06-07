// Deterministic retrieval diversity analysis: how spread-out retrieval is
// across repository files. Metadata ONLY — never affects retrieval, reranking,
// confidence, explainability, budgeting, prompts, or answer generation.
// No AI, no randomness, no timestamps. Inputs are never mutated. Never exposes
// raw chunk content.

import type { EnrichedContextChunk } from "../context/contextTypes.js";

export interface RetrievalDiversity {
  totalFiles: number;
  totalChunks: number;
  diversityScore: number;
  concentrationScore: number;
  classification: "high-diversity" | "medium-diversity" | "low-diversity";
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function classify(diversityScore: number): RetrievalDiversity["classification"] {
  if (diversityScore >= 0.75) return "high-diversity";
  if (diversityScore >= 0.4) return "medium-diversity";
  return "low-diversity";
}

export function buildRetrievalDiversity(
  chunks: EnrichedContextChunk[],
): RetrievalDiversity {
  const totalChunks = chunks.length;

  if (totalChunks === 0) {
    return {
      totalFiles: 0,
      totalChunks: 0,
      diversityScore: 0,
      concentrationScore: 0,
      classification: "low-diversity",
    };
  }

  const countByFile = new Map<string, number>();
  for (const chunk of chunks) {
    countByFile.set(chunk.filePath, (countByFile.get(chunk.filePath) ?? 0) + 1);
  }

  const totalFiles = countByFile.size;
  let largestFileChunkCount = 0;
  for (const count of countByFile.values()) {
    if (count > largestFileChunkCount) largestFileChunkCount = count;
  }

  const diversityScore = round3(totalFiles / totalChunks);
  const concentrationScore = round3(largestFileChunkCount / totalChunks);

  return {
    totalFiles,
    totalChunks,
    diversityScore,
    concentrationScore,
    classification: classify(diversityScore),
  };
}
