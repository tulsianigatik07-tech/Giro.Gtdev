// Splits a source file into line-based chunks with deterministic ids.

import type { CodeChunk, SourceFile } from "./types.js";

export const CHUNK_SIZE = 120; // target lines per chunk
export const CHUNK_OVERLAP = 20; // overlap lines between chunks
export const SMALL_FILE_THRESHOLD = 160; // <= this -> single chunk
export const CHUNKING_STRATEGY_VERSION = "line-window-120-overlap-20-v1";

function makeChunk(file: SourceFile, start: number, end: number): CodeChunk {
  const chunkLines = file.content.split("\n").slice(start, end);
  const content = chunkLines.join("\n");
  const startLine = start + 1;
  const endLine = start + chunkLines.length;
  return {
    chunkId: `${file.filePath}:${startLine}-${endLine}`,
    filePath: file.filePath,
    startLine,
    endLine,
    language: file.language,
    content,
    tokenEstimate: Math.ceil(content.length / 4),
  };
}

export function chunkSourceFile(file: SourceFile): CodeChunk[] {
  const lines = file.content.split("\n");
  if (lines.length === 0) return [];

  if (lines.length <= SMALL_FILE_THRESHOLD) {
    return [makeChunk(file, 0, lines.length)];
  }

  const chunks: CodeChunk[] = [];
  let start = 0;

  while (start < lines.length) {
    const end = Math.min(start + CHUNK_SIZE, lines.length);
    const slice = lines.slice(start, end);

    if (slice.join("").trim() !== "") {
      chunks.push(makeChunk(file, start, end));
    }

    // Termination + infinite-loop guard: stop at EOF or if the window
    // would not move forward (e.g. if overlap >= size).
    const nextStart = end - CHUNK_OVERLAP;
    if (end >= lines.length || nextStart <= start) break;
    start = nextStart;
  }

  return chunks;
}
