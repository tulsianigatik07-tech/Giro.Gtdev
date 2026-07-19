// Orchestrates the full context assembly pipeline: search → rank → dedupe → compress.

import { semanticSearch } from "../embeddings/search.js";
import { rankResults } from "./ranker.js";
import { dedupeResults } from "./deduper.js";
import { compressContext } from "./compressor.js";

const DEFAULT_MAX_CHARS = 12_000;
const SEARCH_LIMIT = 30; // fetch more than needed, then filter down

export interface AssembledContext {
  query: string;
  totalChunks: number;
  estimatedTokens: number;
  context: Array<{
    repository: string;
    filePath: string;
    language: string;
    similarity: number;
    content: string;
    startLine: number;
    endLine: number;
    chunkId?: string;
  }>;
}

export async function buildContext(
  query: string,
  repository: string,
  maxCharacters: number = DEFAULT_MAX_CHARS,
  options: { signal?: AbortSignal } = {},
): Promise<AssembledContext> {
  const raw = await semanticSearch(query, repository, SEARCH_LIMIT, options);
  const ranked = rankResults(raw);
  const deduped = dedupeResults(ranked);
  const compressed = compressContext(deduped, maxCharacters);

  const totalContent = compressed.reduce((sum, c) => sum + c.content.length, 0);

  return {
    query,
    totalChunks: compressed.length,
    estimatedTokens: Math.ceil(totalContent / 4),
    context: compressed.map((c) => ({
      repository: c.repository,
      filePath: c.filePath,
      language: c.language,
      similarity: c.similarity,
      content: c.content,
      startLine: c.startLine,
      endLine: c.endLine,
      chunkId: c.chunkId,
    })),
  };
}
