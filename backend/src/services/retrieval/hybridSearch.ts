// Hybrid retrieval orchestrator: semantic + keyword + symbol + graph reranking.

import { logger } from "../../lib/logger.js";
import { semanticSearch } from "../embeddings/search.js";
import { analyzeRepoDependencies } from "../graph/index.js";
import { keywordSearch } from "./keywordSearch.js";
import { symbolSearch } from "./symbolSearch.js";
import { mergeAndRerank } from "./reranker.js";
import type {
  HybridSearchRequest,
  HybridSearchResponse,
  RetrievalResult,
} from "./types.js";
import { isDeadlineExceeded } from "../../runtime/deadline.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const FETCH_MULTIPLIER = 3;

export function resolveHybridSearchLimit(limit?: number): number {
  return Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));
}

export function resolveHybridFetchLimit(limit?: number): number {
  return resolveHybridSearchLimit(limit) * FETCH_MULTIPLIER;
}

export async function hybridSearch(
  request: HybridSearchRequest,
  options: { signal?: AbortSignal } = {},
): Promise<HybridSearchResponse> {
  const { query, owner, repo } = request;
  const repository = `${owner}/${repo}`;
  const effectiveLimit = resolveHybridSearchLimit(request.limit);
  const fetchLimit = resolveHybridFetchLimit(request.limit);

  const [semanticSettled, keywordSettled, symbolSettled] = await Promise.allSettled([
    semanticSearch(query, fetchLimit, options),
    keywordSearch(query, owner, repo, fetchLimit, options),
    symbolSearch(query, owner, repo, fetchLimit),
  ]);

  let semantic: RetrievalResult[] = [];

  for (const settled of [semanticSettled, keywordSettled]) {
    if (settled.status === "rejected" && isDeadlineExceeded(settled.reason)) throw settled.reason;
  }

  if (semanticSettled.status === "fulfilled") {
    semantic = semanticSettled.value
      .filter((r) => r.repository === repository)
      .map((r) => ({
        repository: r.repository,
        filePath: r.filePath,
        language: r.language,
        content: r.content,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.similarity,
        source: "semantic" as const,
        signals: { semantic: r.similarity },
      }));
  } else {
    logger.error("semantic_search_failed", {
      repository,
      message: String(semanticSettled.reason),
    });
  }

  const keyword =
    keywordSettled.status === "fulfilled" ? keywordSettled.value : [];

  const symbol =
    symbolSettled.status === "fulfilled" ? symbolSettled.value : [];

  let graphNodes: Map<string, number> | null = null;

  try {
    const graph = await analyzeRepoDependencies(owner, repo);

    graphNodes = new Map(
      graph.nodes.map((node) => [
        node.filePath,
        node.centralityScore,
      ]),
    );
  } catch (err) {
    logger.warn("graph_signal_unavailable", {
      repository,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  const combined = [...semantic, ...keyword, ...symbol];

  const graphBoosted = graphNodes
    ? new Set(
        combined
          .filter((result) => graphNodes?.has(result.filePath))
          .map((result) => result.filePath),
      ).size
    : 0;

  const results = mergeAndRerank(
    combined,
    graphNodes,
    effectiveLimit,
  );

  logger.info("hybrid_search_complete", {
    repository,
    semanticResults: semantic.length,
    keywordResults: keyword.length,
    symbolResults: symbol.length,
    graphBoosted,
    returned: results.length,
  });

  return {
    query,
    repository,
    results,
    stats: {
      semanticResults: semantic.length,
      keywordResults: keyword.length,
      symbolResults: symbol.length,
      graphBoosted,
      returned: results.length,
    },
  };
}
