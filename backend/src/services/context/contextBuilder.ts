// Builds the full chunk set for a cloned repository and stores embeddings.

import { readSourceFiles } from "./fileReader.js";
import { chunkSourceFile } from "./chunker.js";
import { generateEmbedding } from "../embeddings/embedder.js";
import { storeChunkEmbedding } from "../embeddings/store.js";
import { supabase } from "../../lib/supabase.js";
import type { ContextBuildResult } from "./types.js";

export async function buildRepositoryContext(
  clonePath: string,
  repository: string,
): Promise<ContextBuildResult> {
  const files = await readSourceFiles(clonePath);
  const chunks = files.flatMap((file) => chunkSourceFile(file));

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    const { data: existing } = await supabase
      .from("repository_chunks")
      .select("id")
      .eq("repository", repository)
      .eq("file_path", chunk.filePath)
      .eq("chunk_index", i)
      .maybeSingle();

    if (existing) continue;

    const embedding = await generateEmbedding(chunk.content);
    await storeChunkEmbedding({
      repository,
      filePath: chunk.filePath,
      language: chunk.language,
      chunkIndex: i,
      content: chunk.content,
      summary: null,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      embedding,
    });
  }

  return {
    totalFilesRead: files.length,
    totalChunks: chunks.length,
    chunks,
  };
}
