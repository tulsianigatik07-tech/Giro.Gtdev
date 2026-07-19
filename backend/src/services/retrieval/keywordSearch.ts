// Keyword retrieval over repository_chunks via ilike, scored locally.

import { supabase } from "../../lib/supabase.js";
import { logger } from "../../lib/logger.js";
import type { RetrievalResult } from "./types.js";
import { env } from "../../config/env.js";
import { createDeadline, isDeadlineExceeded } from "../../runtime/deadline.js";
import { retryDatabaseRead } from "../database/retryPolicy.js";
import type { RetryRuntimeOptions } from "../../runtime/retry.js";
import type { RetryLogger, RetryMetrics } from "../../observability/retryObservability.js";
import { isDependencyUnavailable, type CircuitBreaker } from "../../runtime/circuitBreaker.js";
import { buildCitations, type Citation } from "./citations.js";

export interface KeywordSearchOptions {
  signal?: AbortSignal;
  requestId?: string;
  logger?: RetryLogger;
  metrics?: RetryMetrics;
  retryRuntime?: RetryRuntimeOptions;
  circuitBreaker?: CircuitBreaker;
  repositoryVersion?: string;
  databaseClient?: Pick<typeof supabase, "from">;
}

interface ChunkRow {
  id?: string;
  repository: string;
  file_path: string;
  language: string;
  content: string;
  start_line: number;
  end_line: number;
}

export async function keywordSearch(
  query: string,
  owner: string,
  repo: string,
  limit: number = 20,
  options: KeywordSearchOptions = {},
): Promise<RetrievalResult[]> {
  const repository = `${owner}/${repo}`;
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);

  if (tokens.length === 0) return [];

  const orFilter = tokens
    .map((t) => `content.ilike.%${t}%,file_path.ilike.%${t}%`)
    .join(",");

  let rows: ChunkRow[];
  const deadline = createDeadline(env.DATABASE_REQUEST_TIMEOUT_MS, { parentSignal: options.signal });
  try {
    const { data, error } = await retryDatabaseRead(
      () => {
        let databaseQuery = (options.databaseClient ?? supabase)
          .from("repository_chunks")
          .select("id,repository,file_path,language,content,start_line,end_line")
          .eq("repository", repository);
        if (options.repositoryVersion) {
          databaseQuery = databaseQuery.eq("repository_revision", options.repositoryVersion);
        }
        return databaseQuery.or(orFilter).limit(limit * 3).abortSignal(deadline.signal);
      },
      {
        deadline,
        operation: "keyword_search",
        requestId: options.requestId,
        logger: options.logger,
        metrics: options.metrics,
        retryRuntime: options.retryRuntime,
        circuitBreaker: options.circuitBreaker,
      },
    );
    if (deadline.signal.aborted) throw deadline.signal.reason;
    if (error) throw new Error("Keyword search failed.");
    rows = (data ?? []) as ChunkRow[];
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    logger.error("keyword_search_failed", {
      repository,
      message: "Keyword search failed.",
    });
    return [];
  } finally {
    deadline.dispose();
  }

  const phrase = query.toLowerCase().trim();
  const scored = rows.map((row) => {
    const content = row.content.toLowerCase();
    const filePath = row.file_path.toLowerCase();
    let raw = 0;
    for (const token of tokens) {
      if (content.includes(token)) raw += 1.0;
      if (filePath.includes(token)) raw += 1.5;
    }
    if (phrase.length > 0 && content.includes(phrase)) raw += 2.0;
    return { row, raw };
  });

  const maxRaw = scored.reduce((m, s) => (s.raw > m ? s.raw : m), 0) || 1;

  return scored
    .filter((s) => s.raw > 0)
    .map((s) => ({
      repository: s.row.repository,
      filePath: s.row.file_path,
      language: s.row.language,
      content: s.row.content,
      startLine: s.row.start_line,
      endLine: s.row.end_line,
      score: Math.min(1, s.raw / maxRaw),
      source: "keyword" as const,
      signals: { keyword: Math.min(1, s.raw / maxRaw) },
      chunkId: s.row.id,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine,
    )
    .slice(0, limit);
}

export async function keywordSearchWithCitations(
  query: string,
  owner: string,
  repo: string,
  limit: number = 20,
  options: KeywordSearchOptions & { repositoryVersion?: string } = {},
): Promise<{ results: RetrievalResult[]; citations: Citation[] }> {
  const results = await keywordSearch(query, owner, repo, limit, options);
  const repositoryId = `${owner}/${repo}`;
  return {
    results,
    citations: buildCitations(results.map((result) => ({
      repositoryId,
      filePath: result.filePath,
      language: result.language,
      chunkId: result.chunkId,
      startLine: result.startLine,
      endLine: result.endLine,
      retrievalType: "keyword",
      score: result.score,
      repositoryVersion: options.repositoryVersion ?? "unversioned",
    })), { surface: "keyword" }),
  };
}
