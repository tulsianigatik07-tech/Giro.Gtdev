// Builds the full chunk set for a cloned repository and stores embeddings.

import { readSourceFiles } from "./fileReader.js";
import { chunkSourceFile } from "./chunker.js";
import { generateEmbedding } from "../embeddings/embedder.js";
import {
  runtimeEmbeddingIndexStore,
  type EmbeddingIndexStore,
} from "../embeddings/indexStore.js";
import { runtimeEmbeddingIndexConfiguration } from "../embeddings/indexVersion.js";
import { createHash } from "node:crypto";
import type { ContextBuildResult } from "./types.js";
import type { RetryLogger, RetryMetrics } from "../../observability/retryObservability.js";
import type { CircuitBreaker } from "../../runtime/circuitBreaker.js";
import type { TrustedRepositoryCheckoutPath } from "../security/repositoryPaths.js";

export async function buildRepositoryContext(
  clonePath: TrustedRepositoryCheckoutPath,
  repository: string,
  options: {
    signal?: AbortSignal;
    requestId?: string;
    logger?: RetryLogger;
    metrics?: RetryMetrics;
    embeddingCircuitBreaker?: CircuitBreaker;
    repositoryVersion?: string;
    embeddingVersion?: string;
    embeddingIndexStore?: EmbeddingIndexStore;
  } = {},
): Promise<ContextBuildResult> {
  if (!options.repositoryVersion?.trim()) {
    throw new Error("Immutable repository revision is required for indexing.");
  }
  const files = await readSourceFiles(clonePath);
  const chunks = files.flatMap((file) => chunkSourceFile(file));
  const embeddingIndexStore = options.embeddingIndexStore ?? runtimeEmbeddingIndexStore;
  const embeddingVersion = options.embeddingVersion ??
    runtimeEmbeddingIndexConfiguration(repository, options.repositoryVersion).embeddingVersion;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const chunkHash = createHash("sha256")
      .update([chunk.filePath, chunk.chunkId, chunk.content].join("\u0000"))
      .digest("hex");
    if (await embeddingIndexStore.hasChunk(embeddingVersion, chunk.chunkId, options.signal)) continue;

    const embedding = await generateEmbedding(chunk.content, {
      ...options,
      circuitBreaker: options.embeddingCircuitBreaker,
    });
    await embeddingIndexStore.storeChunk({
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
      embeddingVersion,
      chunkId: chunk.chunkId,
      chunkHash,
      tokenCount: chunk.tokenEstimate,
    }, options.signal);
  }

  return {
    totalFilesRead: files.length,
    totalChunks: chunks.length,
    chunks,
  };
}
