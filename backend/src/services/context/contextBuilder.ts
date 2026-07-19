// Builds the full chunk set for a cloned repository and stores embeddings.

import { readSourceFiles } from "./fileReader.js";
import { chunkSourceFile } from "./chunker.js";
import { generateEmbedding } from "../embeddings/embedder.js";
import { storeChunkEmbedding } from "../embeddings/store.js";
import { supabase } from "../../lib/supabase.js";
import type { ContextBuildResult } from "./types.js";
import { env } from "../../config/env.js";
import { createDeadline } from "../../runtime/deadline.js";
import type { RetryLogger, RetryMetrics } from "../../observability/retryObservability.js";
import type { CircuitBreaker } from "../../runtime/circuitBreaker.js";

export async function buildRepositoryContext(
  clonePath: string,
  repository: string,
  options: {
    signal?: AbortSignal;
    requestId?: string;
    logger?: RetryLogger;
    metrics?: RetryMetrics;
    embeddingCircuitBreaker?: CircuitBreaker;
    repositoryVersion?: string;
  } = {},
): Promise<ContextBuildResult> {
  const files = await readSourceFiles(clonePath);
  const chunks = files.flatMap((file) => chunkSourceFile(file));

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;

    const databaseDeadline = createDeadline(env.DATABASE_REQUEST_TIMEOUT_MS, { parentSignal: options.signal });
    let existing: unknown;
    try {
      const response = await supabase
        .from("repository_chunks")
        .select("id")
        .eq("repository", repository)
        .eq("repository_revision", options.repositoryVersion ?? "unversioned")
        .eq("file_path", chunk.filePath)
        .eq("chunk_index", i)
        .abortSignal(databaseDeadline.signal)
        .maybeSingle();
      if (databaseDeadline.signal.aborted) throw databaseDeadline.signal.reason;
      existing = response.data;
    } finally {
      databaseDeadline.dispose();
    }

    if (existing) continue;

    const embedding = await generateEmbedding(chunk.content, {
      ...options,
      circuitBreaker: options.embeddingCircuitBreaker,
    });
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
      repositoryRevision: options.repositoryVersion,
      tokenCount: chunk.tokenEstimate,
    }, options);
  }

  return {
    totalFilesRead: files.length,
    totalChunks: chunks.length,
    chunks,
  };
}
