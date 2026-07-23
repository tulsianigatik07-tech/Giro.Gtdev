// Hybrid retrieval orchestrator: semantic + keyword + symbol + graph reranking.

import { logger } from "../../lib/logger.js";
import { semanticSearch } from "../embeddings/search.js";
import { runtimeRepositoryArtifactStore } from "../repository/artifacts/repositoryArtifactStore.js";
import type { PublishedRepositoryArtifacts } from "../repository/artifacts/repositoryArtifactStore.js";
import { keywordSearch } from "./keywordSearch.js";
import { pathSearch } from "./pathSearch.js";
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
import { recordRuntimeRankingCacheHit } from "./ranking/runtimeWeightedRanker.js";
import { executeHybridRetrievalV2 } from "./hybridV2/pipeline.js";
import { runtimeHybridRetrievalV2Config } from "./hybridV2/config.js";
import type { HybridRetrievalDiagnostics, SourceCandidate } from "./hybridV2/types.js";

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
  artifacts?: PublishedRepositoryArtifacts | null;
  diagnosticsSink?: (diagnostics: HybridRetrievalDiagnostics) => void;
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
  const artifacts = options.artifacts ?? (options.repositoryVersion
    ? await runtimeRepositoryArtifactStore.load(repository, options.repositoryVersion)
    : null);
  const expansion = options.queryExpansion ?? expandRuntimeQuery({
    repositoryId: repository,
    repositoryVersion: options.repositoryVersion ?? "unversioned",
    query,
    artifacts,
  });
  const expandedQuery = expansion.expandedQuery;

  const [
    semanticSettled,
    keywordSettled,
    symbolSettled,
    pathSettled,
    expandedSemanticSettled,
    expandedKeywordSettled,
    expandedSymbolSettled,
    expandedPathSettled,
  ] = await Promise.allSettled([
    semanticSearch(query, repository, fetchLimit, options),
    keywordSearch(query, owner, repo, fetchLimit, options),
    symbolSearch(query, owner, repo, fetchLimit, { repositoryVersion: options.repositoryVersion }),
    pathSearch(query, owner, repo, fetchLimit, options),
    expandedQuery
      ? semanticSearch(expandedQuery, repository, fetchLimit, options)
      : Promise.resolve([]),
    expandedQuery
      ? keywordSearch(expandedQuery, owner, repo, fetchLimit, options)
      : Promise.resolve([]),
    expandedQuery
      ? symbolSearch(expandedQuery, owner, repo, fetchLimit, { repositoryVersion: options.repositoryVersion })
      : Promise.resolve([]),
    expandedQuery
      ? pathSearch(expandedQuery, owner, repo, fetchLimit, options)
      : Promise.resolve([]),
  ]);

  let semantic: RetrievalResult[] = [];

  for (const settled of [
    semanticSettled,
    keywordSettled,
    expandedSemanticSettled,
    expandedKeywordSettled,
    pathSettled,
    expandedPathSettled,
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
  const path = pathSettled.status === "fulfilled" ? pathSettled.value : [];

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
  const expandedPath = expandedPathSettled.status === "fulfilled"
    ? expandedPathSettled.value
    : [];

  let graphNodes: Map<string, number> | null = null;

  try {
    const graph = artifacts?.graph ?? null;
    if (graph && graph.repositoryVersion === options.repositoryVersion) {
      graphNodes = new Map(graph.nodes.map((node) => [node.file, 1]));
    }
  } catch (err) {
    logger.warn("graph_signal_unavailable", {
      repository,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  const combined: SourceCandidate[] = [
    ...semantic.map((result) => ({ source: "semantic" as const, result, isExpanded: false })),
    ...keyword.map((result) => ({ source: "lexical" as const, result, isExpanded: false })),
    ...symbol.map((result) => ({ source: "symbol" as const, result, isExpanded: false })),
    ...path.map((result) => ({ source: "path" as const, result, isExpanded: false })),
    ...expandedSemantic.map((result) => ({ source: "semantic" as const, result, isExpanded: true })),
    ...expandedKeyword.map((result) => ({ source: "lexical" as const, result, isExpanded: true })),
    ...expandedSymbol.map((result) => ({ source: "symbol" as const, result, isExpanded: true })),
    ...expandedPath.map((result) => ({ source: "path" as const, result, isExpanded: true })),
  ];

  const graphBoosted = graphNodes
    ? new Set(
        combined
          .filter((candidate) => graphNodes?.has(candidate.result.filePath))
          .map((candidate) => candidate.result.filePath),
      ).size
    : 0;

  const primaryKeys = new Set(combined
    .filter((candidate) => !candidate.isExpanded)
    .map((candidate) => candidate.result.chunkId ??
      `${candidate.result.filePath}\u0000${candidate.result.startLine}\u0000${candidate.result.endLine}`));
  const ranking = await executeHybridRetrievalV2({
    query,
    repositoryId: repository,
    repositoryRevision: options.repositoryVersion ?? "unversioned",
    candidates: combined,
    artifacts,
    limit: effectiveLimit,
    expansionMultiplier: expansion.expandedScoreMultiplier,
  }, {
    signal: options.signal,
  });
  options.diagnosticsSink?.(ranking.diagnostics);
  const rankedPool = ranking.results;
  const primaryChunkCount = rankedPool.length;
  const stitchingInputs = rankedPool.map((result) => {
    const key = result.chunkId ??
      `${result.filePath}\u0000${result.startLine}\u0000${result.endLine}`;
    return {
      repositoryId: repository,
      filePath: result.filePath,
      repositoryVersion: options.repositoryVersion ?? "unversioned",
      retrievalOperation: "hybrid",
      content: result.content,
      startLine: result.startLine,
      endLine: result.endLine,
      score: result.score,
      symbol: result.symbol,
      citations: [] as CitationCandidate[],
      result,
      primaryQueryMatch: primaryKeys.has(key),
      queryExpansionMatch: !primaryKeys.has(key),
    };
  });
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
  // Injected executors are deterministic test seams and do not consume runtime
  // repository artifacts. Production retrieval always resolves the revision.
  const artifacts = options.execute
    ? null
    : await runtimeRepositoryArtifactStore.load(repositoryId, repositoryVersion);
  const expansion = expandRuntimeQuery({
    repositoryId,
    repositoryVersion,
    query: request.query,
    artifacts,
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
        retrievalV2: runtimeHybridRetrievalV2Config,
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
        artifacts: context.repositoryVersion === repositoryVersion ? artifacts : null,
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
