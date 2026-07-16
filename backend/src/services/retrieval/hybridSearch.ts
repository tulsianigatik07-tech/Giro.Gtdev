// Hybrid retrieval orchestrator: semantic + keyword + symbol + graph reranking.

import { logger } from "../../lib/logger.js";
import { semanticSearch } from "../embeddings/search.js";
import { analyzeRepoDependencies } from "../graph/index.js";
import { keywordSearch } from "./keywordSearch.js";
import { symbolSearch } from "./symbolSearch.js";
import type {
  HybridSearchRequest,
  HybridSearchResponse,
  RetrievalResult,
} from "./types.js";
import { isDeadlineExceeded } from "../../runtime/deadline.js";
import { isDependencyUnavailable } from "../../runtime/circuitBreaker.js";
import { runtimeRetrievalCache } from "./cache/runtimeRetrievalCache.js";
import type { RetrievalCache } from "./cache/retrievalCache.js";
import { buildCitations, type CitationCandidate } from "./citations.js";
import { stitchRuntimeChunks } from "./stitching/runtimeChunkStitcher.js";
import { expandRuntimeQuery } from "./queryExpansion/runtimeQueryExpansion.js";
import type { QueryExpansionResult } from "./queryExpansion/queryExpansionTypes.js";
import {
  rankRuntimeHybridCandidates,
  recordRuntimeRankingCacheHit,
  runtimeRankingWeights,
  type RuntimeRankingCandidate,
} from "./ranking/runtimeWeightedRanker.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const FETCH_MULTIPLIER = 3;

export function resolveHybridSearchLimit(limit?: number): number {
  return Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));
}

export function resolveHybridFetchLimit(limit?: number): number {
  return resolveHybridSearchLimit(limit) * FETCH_MULTIPLIER;
}

export interface HybridSearchOptions {
  signal?: AbortSignal;
  cache?: RetrievalCache;
  execute?: typeof executeHybridSearch;
}

export interface ExecuteHybridSearchOptions {
  signal?: AbortSignal;
  repositoryVersion?: string;
  queryExpansion?: QueryExpansionResult;
}

export function applyQueryExpansionPenalty(
  results: readonly RetrievalResult[],
  scoreMultiplier: number,
): RetrievalResult[] {
  return results.map((result) => ({
    ...result,
    score: result.score * scoreMultiplier,
    signals: Object.fromEntries(
      Object.entries(result.signals).map(([key, value]) => [
        key,
        value === undefined ? value : value * scoreMultiplier,
      ]),
    ),
  }));
}

export async function executeHybridSearch(
  request: HybridSearchRequest,
  options: ExecuteHybridSearchOptions = {},
): Promise<HybridSearchResponse> {
  const { query, owner, repo } = request;
  const repository = `${owner}/${repo}`;
  const effectiveLimit = resolveHybridSearchLimit(request.limit);
  const fetchLimit = resolveHybridFetchLimit(request.limit);
  const expansion = options.queryExpansion ?? expandRuntimeQuery({
    repositoryId: repository,
    repositoryVersion: options.repositoryVersion ?? "unversioned",
    query,
  });
  const expandedQuery = expansion.expandedQuery;

  const [
    semanticSettled,
    keywordSettled,
    symbolSettled,
    expandedSemanticSettled,
    expandedKeywordSettled,
    expandedSymbolSettled,
  ] = await Promise.allSettled([
    semanticSearch(query, fetchLimit, options),
    keywordSearch(query, owner, repo, fetchLimit, options),
    symbolSearch(query, owner, repo, fetchLimit),
    expandedQuery
      ? semanticSearch(expandedQuery, fetchLimit, options)
      : Promise.resolve([]),
    expandedQuery
      ? keywordSearch(expandedQuery, owner, repo, fetchLimit, options)
      : Promise.resolve([]),
    expandedQuery
      ? symbolSearch(expandedQuery, owner, repo, fetchLimit)
      : Promise.resolve([]),
  ]);

  let semantic: RetrievalResult[] = [];

  for (const settled of [
    semanticSettled,
    keywordSettled,
    expandedSemanticSettled,
    expandedKeywordSettled,
  ]) {
    if (
      settled.status === "rejected" &&
      (isDeadlineExceeded(settled.reason) || isDependencyUnavailable(settled.reason))
    ) throw settled.reason;
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
        chunkId: r.chunkId,
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

  const expandedSemantic: RetrievalResult[] = expandedSemanticSettled.status === "fulfilled"
    ? expandedSemanticSettled.value
      .filter((result) => result.repository === repository)
      .map((result) => ({
        repository: result.repository,
        filePath: result.filePath,
        language: result.language,
        content: result.content,
        startLine: result.startLine,
        endLine: result.endLine,
        score: result.similarity,
        source: "semantic" as const,
        signals: { semantic: result.similarity },
        chunkId: result.chunkId,
      }))
    : [];
  const expandedKeyword = expandedKeywordSettled.status === "fulfilled"
    ? expandedKeywordSettled.value
    : [];
  const expandedSymbol = expandedSymbolSettled.status === "fulfilled"
    ? expandedSymbolSettled.value
    : [];

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

  const combined: RuntimeRankingCandidate[] = [
    ...semantic.map((result) => ({ result, isExpanded: false })),
    ...keyword.map((result) => ({ result, isExpanded: false })),
    ...symbol.map((result) => ({ result, isExpanded: false })),
    ...expandedSemantic.map((result) => ({ result, isExpanded: true })),
    ...expandedKeyword.map((result) => ({ result, isExpanded: true })),
    ...expandedSymbol.map((result) => ({ result, isExpanded: true })),
  ];

  const graphBoosted = graphNodes
    ? new Set(
        combined
          .filter((candidate) => graphNodes?.has(candidate.result.filePath))
          .map((candidate) => candidate.result.filePath),
      ).size
    : 0;

  const ranking = rankRuntimeHybridCandidates({
    repositoryId: repository,
    repositoryVersion: options.repositoryVersion ?? "unversioned",
    candidates: combined,
    graphNodes,
    expandedScoreMultiplier: expansion.expandedScoreMultiplier,
    limit: combined.length,
  });
  const rankedPool = ranking.ranked;
  const primaryChunkCount = Math.min(effectiveLimit, rankedPool.length);
  const stitchingInputs = rankedPool.map((rankedCandidate) => ({
    repositoryId: repository,
    filePath: rankedCandidate.result.filePath,
    repositoryVersion: options.repositoryVersion ?? "unversioned",
    retrievalOperation: "hybrid",
    content: rankedCandidate.result.content,
    startLine: rankedCandidate.result.startLine,
    endLine: rankedCandidate.result.endLine,
    score: rankedCandidate.result.score,
    symbol: rankedCandidate.result.symbol,
    citations: [] as CitationCandidate[],
    result: rankedCandidate.result,
    primaryQueryMatch: rankedCandidate.trace.expansionPenalty === 0,
    queryExpansionMatch: rankedCandidate.trace.expansionPenalty > 0,
  }));
  const stitched = stitchRuntimeChunks(stitchingInputs, { primaryChunkCount });
  const results = stitched.chunks.map((block) => {
    const primary = block.primaryChunk as (typeof stitchingInputs)[number];
    return {
      ...primary.result,
      content: block.content,
      startLine: block.startLine,
      endLine: block.endLine,
      primaryQueryMatch: block.contributors.some((contributor) =>
        (contributor as (typeof stitchingInputs)[number]).primaryQueryMatch
      ),
      queryExpansionMatch: block.contributors.some((contributor) =>
        (contributor as (typeof stitchingInputs)[number]).queryExpansionMatch
      ),
      stitchedNeighborCount: Math.max(0, block.contributors.length - 1),
    };
  });
  const citations = buildCitations(
    stitched.chunks.flatMap((block) => block.contributors.map((contributor) => {
      const original = contributor as (typeof stitchingInputs)[number];
      return {
        repositoryId: original.repositoryId,
        filePath: original.filePath,
        language: original.result.language,
        chunkId: original.result.chunkId,
        startLine: original.startLine,
        endLine: original.endLine,
        retrievalType: "hybrid" as const,
        score: original.score,
        symbol: original.symbol,
        repositoryVersion: original.repositoryVersion,
      };
    })),
    { surface: "hybrid" },
  );

  logger.info("hybrid_search_complete", {
    repository,
    semanticResults: semantic.length + expandedSemantic.length,
    keywordResults: keyword.length + expandedKeyword.length,
    symbolResults: symbol.length + expandedSymbol.length,
    graphBoosted,
    returned: results.length,
  });

  return {
    query,
    repository,
    results,
    citations,
    stats: {
      semanticResults: semantic.length + expandedSemantic.length,
      keywordResults: keyword.length + expandedKeyword.length,
      symbolResults: symbol.length + expandedSymbol.length,
      graphBoosted,
      returned: results.length,
    },
  };
}

export async function hybridSearch(
  request: HybridSearchRequest,
  options: HybridSearchOptions = {},
): Promise<HybridSearchResponse> {
  const effectiveLimit = resolveHybridSearchLimit(request.limit);
  const cache = options.cache ?? runtimeRetrievalCache;
  const repositoryId = `${request.owner}/${request.repo}`;
  const repositoryVersion = await cache.repositoryVersion(repositoryId, options.signal);
  const expansion = expandRuntimeQuery({
    repositoryId,
    repositoryVersion,
    query: request.query,
  });
  let retrievalLoaded = false;
  const cached = await cache.getOrLoad(
    {
      repositoryId,
      query: request.query,
      mode: "hybrid",
      limits: {
        requested: request.limit,
        effective: effectiveLimit,
        fetch: resolveHybridFetchLimit(request.limit),
      },
      selectedContext: null,
      options: {
        queryExpansion: {
          terms: expansion.terms.map((term) => term.term),
          scoreMultiplier: expansion.expandedScoreMultiplier,
        },
        rankingWeights: runtimeRankingWeights,
      },
      repositoryVersion,
    },
    (signal, context) => {
      retrievalLoaded = true;
      const currentExpansion = context.repositoryVersion === expansion.repositoryVersion
        ? expansion
        : expandRuntimeQuery({
            repositoryId,
            repositoryVersion: context.repositoryVersion,
            query: request.query,
          });
      return (options.execute ?? executeHybridSearch)(request, {
        signal,
        repositoryVersion: context.repositoryVersion,
        queryExpansion: currentExpansion,
      });
    },
    { signal: options.signal },
  );
  if (!retrievalLoaded) recordRuntimeRankingCacheHit(cached.results.length);
  const query = request.query;
  const repository = `${request.owner}/${request.repo}`;
  if (cached.query === query && cached.repository === repository) return cached;
  return Object.freeze({ ...cached, query, repository });
}
