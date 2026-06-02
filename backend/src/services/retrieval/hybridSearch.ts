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

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export async function hybridSearch(
  request: HybridSearchRequest,
): Promise<HybridSearchResponse> {
  const { query, owner, repo } = request;
  const repository = `${owner}/${repo}`;
  const effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, request.limit ?? DEFAULT_LIMIT));
  const fetchLimit = effectiveLimit * 3;

  const [semanticSettled, keywordSettled, symbolSettled] = await Promise.allSettled([
    semanticSearch(query, fetchLimit),
    keywordSearch(query, owner, repo, fetchLimit),
    symbolSearch(query, owner, repo, fetchLimit),
  ]);

  let semantic: RetrievalResult[] = [];
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

  const keyword = keywordSettled.status === "fulfilled" ? keywordSettled.value : [];
  const symbol = symbolSettled.status === "fulfilled" ? symbolSettled.value : [];

  // Build graph centrality map; degrade gracefully if unavailable.
  let graphNodes: Map<string, number> | null = null;
  try {
    const graph = await analyzeRepoDependencies(owner, repo);
    graphNodes = new Map(graph.nodes.map((n) => [n.filePath, n.centralityScore]));
  } catch (err) {
    logger.warn("graph_signal_unavailable", {
      repository,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  const combined = [...semantic, ...keyword, ...symbol];
  const graphFiles = graphNodes;
  const graphBoosted = graphFiles
    ? new Set(
        combined.filter((r) => graphFiles.has(r.filePath)).map((r) => r.filePath),
      ).size
    : 0;

  const results = mergeAndRerank(combined, graphNodes, effectiveLimit);

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
