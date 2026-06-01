import { supabase } from "../../lib/supabase.js";

interface StoreInput {
  repository: string;
  filePath: string;
  language: string;
  chunkIndex: number;
  content: string;
  summary: string | null;
  startLine: number;
  endLine: number;
  embedding: number[];
}

export async function storeChunkEmbedding(input: StoreInput): Promise<void> {
  const { error } = await supabase.from("repository_chunks").insert({
    repository: input.repository,
    file_path: input.filePath,
    language: input.language,
    chunk_index: input.chunkIndex,
    content: input.content,
    summary: input.summary,
    start_line: input.startLine,
    end_line: input.endLine,
    embedding: input.embedding,
  });

  if (error) {
    throw new Error(`Failed to store chunk: ${error.message}`);
  }
}
