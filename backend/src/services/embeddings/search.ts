import { supabase } from "../../lib/supabase.js";
import { generateEmbedding } from "./embedder.js";
import type { SemanticSearchResult } from "./types.js";
import { env } from "../../config/env.js";
import { createDeadline, DeadlineExceededError, isDeadlineExceeded } from "../../runtime/deadline.js";
import { retryDatabaseRead } from "../database/retryPolicy.js";
import type { RetryRuntimeOptions } from "../../runtime/retry.js";
import type { RetryLogger, RetryMetrics } from "../../observability/retryObservability.js";
import { isDependencyUnavailable, type CircuitBreaker } from "../../runtime/circuitBreaker.js";
import { buildCitations, type Citation } from "../retrieval/citations.js";
import { runtimeEmbeddingIndexConfiguration } from "./indexVersion.js";

export interface SemanticSearchOptions {
  signal?: AbortSignal;
  requestId?: string;
  logger?: RetryLogger;
  metrics?: RetryMetrics;
  retryRuntime?: RetryRuntimeOptions;
  circuitBreaker?: CircuitBreaker;
  databaseClient?: Pick<typeof supabase, "rpc">;
  generateQueryEmbedding?: typeof generateEmbedding;
}

export async function semanticSearch(
  query: string,
  repository: string,
  limit: number = 10,
  options: SemanticSearchOptions & { repositoryVersion?: string } = {},
): Promise<SemanticSearchResult[]> {
  if (!options.repositoryVersion?.trim()) {
    throw new Error("Published repository revision is required for semantic search.");
  }
  const embedding = await (options.generateQueryEmbedding ?? generateEmbedding)(query, options);
  const embeddingConfiguration = runtimeEmbeddingIndexConfiguration(repository, options.repositoryVersion);
  const deadline = createDeadline(env.DATABASE_REQUEST_TIMEOUT_MS, { parentSignal: options.signal });

  try {
    const { data, error } = await retryDatabaseRead(
      () => (options.databaseClient ?? supabase).rpc("match_repository_chunks", {
        input_repository: repository,
        query_embedding: embedding,
        match_count: limit,
        input_repository_revision: options.repositoryVersion,
        input_embedding_version: embeddingConfiguration.embeddingVersion,
      }).abortSignal(deadline.signal),
      {
        deadline,
        operation: "semantic_search",
        requestId: options.requestId,
        logger: options.logger,
        metrics: options.metrics,
        retryRuntime: options.retryRuntime,
        circuitBreaker: options.circuitBreaker,
      },
    );

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
      chunkId: typeof row.id === "string" ? row.id : undefined,
    }));
  } catch (error) {
    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (isDeadlineExceeded(error) || isDependencyUnavailable(error)) throw error;
    throw new Error("Semantic search failed.");
  } finally {
    deadline.dispose();
  }
}

export async function semanticSearchWithCitations(
  query: string,
  repository: string,
  limit: number = 10,
  options: SemanticSearchOptions & {
    repositoryVersion?: string;
  } = {},
): Promise<{ results: SemanticSearchResult[]; citations: Citation[] }> {
  const results = await semanticSearch(query, repository, limit, options);
  const citations = buildCitations(results.map((result) => ({
    repositoryId: result.repository,
    filePath: result.filePath,
    language: result.language,
    chunkId: result.chunkId,
    startLine: result.startLine,
    endLine: result.endLine,
    retrievalType: "semantic",
    score: result.similarity,
    repositoryVersion: options.repositoryVersion ?? "unversioned",
  })), { surface: "semantic" });
  return { results, citations };
}
