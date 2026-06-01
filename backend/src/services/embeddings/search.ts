import { supabase } from "../../lib/supabase.js";
import { generateEmbedding } from "./embedder.js";
import type { SemanticSearchResult } from "./types.js";

export async function semanticSearch(
  query: string,
  limit: number = 10,
): Promise<SemanticSearchResult[]> {
  const embedding = await generateEmbedding(query);

  const { data, error } = await supabase.rpc("match_repository_chunks", {
    query_embedding: embedding,
    match_count: limit,
  });

  if (error) {
    throw new Error(`Semantic search failed: ${error.message}`);
  }

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
}
