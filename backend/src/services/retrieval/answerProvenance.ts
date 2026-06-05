// Deterministic answer provenance metadata: which files contributed to the
// final answer context. Metadata ONLY — never influences retrieval, ranking,
// selection, scoring, traces, debug report, or answer generation.
// No AI, no randomness, no timestamps. Inputs are never mutated.

import type { EnrichedContextChunk } from "../context/contextTypes.js";

export interface AnswerProvenanceFile {
  filePath: string;
  chunkCount: number;
}

export interface AnswerProvenance {
  files: AnswerProvenanceFile[];
  totalFiles: number;
  totalChunks: number;
}

export function buildAnswerProvenance(
  chunks: EnrichedContextChunk[],
): AnswerProvenance {
  const countByFile = new Map<string, number>();
  for (const chunk of chunks) {
    countByFile.set(chunk.filePath, (countByFile.get(chunk.filePath) ?? 0) + 1);
  }

  const files: AnswerProvenanceFile[] = [...countByFile.entries()]
    .map(([filePath, chunkCount]) => ({ filePath, chunkCount }))
    .sort(
      (a, b) => b.chunkCount - a.chunkCount || a.filePath.localeCompare(b.filePath),
    );

  return {
    files,
    totalFiles: files.length,
    totalChunks: chunks.length,
  };
}
