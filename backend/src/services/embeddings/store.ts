import { supabase } from "../../lib/supabase.js";
import { env } from "../../config/env.js";
import { createDeadline } from "../../runtime/deadline.js";

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

export async function storeChunkEmbedding(input: StoreInput, options: { signal?: AbortSignal } = {}): Promise<void> {
  const deadline = createDeadline(env.DATABASE_REQUEST_TIMEOUT_MS, { parentSignal: options.signal });
  try {
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
    }).abortSignal(deadline.signal);

    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (error) throw new Error("Failed to store chunk.");
  } finally {
    deadline.dispose();
  }
}
