import { supabase } from "../../lib/supabase.js";
import { generateEmbedding } from "./embedder.js";
import type { SemanticSearchResult } from "./types.js";
import { env } from "../../config/env.js";
import { createDeadline, DeadlineExceededError, isDeadlineExceeded } from "../../runtime/deadline.js";

export async function semanticSearch(
  query: string,
  limit: number = 10,
  options: { signal?: AbortSignal } = {},
): Promise<SemanticSearchResult[]> {
  const embedding = await generateEmbedding(query, options);
  const deadline = createDeadline(env.DATABASE_REQUEST_TIMEOUT_MS, { parentSignal: options.signal });

  try {
    const { data, error } = await supabase.rpc("match_repository_chunks", {
      query_embedding: embedding,
      match_count: limit,
    }).abortSignal(deadline.signal);

    if (deadline.signal.aborted && isDeadlineExceeded(deadline.signal.reason)) throw new DeadlineExceededError();
    if (error) throw new Error("Semantic search failed.");

    if (!data || (data as unknown[]).length === 0) return [];

    return (data as Array<Record<string, unknown>>).map((row) => ({
      repository: row.repository as string,
      filePath: row.file_path as string,
      language: row.language as string,
      content: row.content as string,
      similarity: row.similarity as number,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
    }));
  } finally {
    deadline.dispose();
  }
}
