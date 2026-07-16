// Enriched context assembler: combines hybrid retrieval + file-level search into
// a single deterministic, budget-bounded context payload. Read-only.

import { hybridSearch } from "../retrieval/hybridSearch.js";
import { searchRepositoryFiles } from "../fileSearch/index.js";
import { rerankChunks } from "../retrieval/qualityReranker.js";
import { buildConfidenceMetadata } from "../retrieval/confidenceScorer.js";
import { buildRetrievalDebugReport } from "../retrieval/debugReport.js";
import { buildAnswerProvenance } from "../retrieval/answerProvenance.js";
import { buildRetrievalExplainability } from "../retrieval/explainability.js";
import { buildRepositoryCoverage } from "../retrieval/repositoryCoverage.js";
import { buildRetrievalHotspots } from "../retrieval/retrievalHotspots.js";
import { buildRetrievalDiversity } from "../retrieval/retrievalDiversity.js";
import { buildRetrievalBlindSpots } from "../retrieval/retrievalBlindSpots.js";
import { buildRetrievalQualityScore } from "../retrieval/retrievalQualityScore.js";
import { repoClonePath } from "../repository/clone.js";
import { logger } from "../../lib/logger.js";
import { existsSync } from "node:fs";
import type {
  EnrichedAssemblyRequest,
  EnrichedAssembledContext,
  EnrichedContextChunk,
} from "./contextTypes.js";
import { isDeadlineExceeded } from "../../runtime/deadline.js";
import { isDependencyUnavailable } from "../../runtime/circuitBreaker.js";
import type { RetrievalCache } from "../retrieval/cache/retrievalCache.js";
import { runtimeRetrievalCache } from "../retrieval/cache/runtimeRetrievalCache.js";
import {
  buildCitations,
  repositoryRelativePath,
  type Citation,
} from "../retrieval/citations.js";
import { getRepositorySummary } from "../repositorySummary/runtimeRepositorySummary.js";
import { recordRuntimeStitchBudgetDrops } from "../retrieval/stitching/runtimeChunkStitcher.js";
import {
  enrichedChunksToConfidenceCandidates,
  toPublicRetrievalConfidence,
} from "../retrieval/confidence/retrievalConfidence.js";
import { evaluateRuntimeRetrievalConfidence } from "../retrieval/confidence/runtimeRetrievalConfidence.js";

const TRIM_PREFIX_CHARS = 500;
const TRIM_MARKER = "\n/* … trimmed … */";
const SUMMARY_CONTEXT_MAX_CHARS = 2_000;

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function roundSignals(
  signals: EnrichedContextChunk["signals"],
): EnrichedContextChunk["signals"] {
  const out: EnrichedContextChunk["signals"] = {};
  for (const key of ["semantic", "keyword", "symbol", "graph", "fileSearch"] as const) {
    const v = signals[key];
    if (v !== undefined) out[key] = round3(v);
  }
  return out;
}

export function buildContextCitations(
  repositoryId: string,
  chunks: readonly EnrichedContextChunk[],
  repositoryVersion: string,
  carriedCitations: readonly Citation[] = [],
) {
  const finalizedHybridRanges = chunks
    .filter((chunk) => chunk.citationRetrievalType === "hybrid")
    .map((chunk) => ({
      path: repositoryRelativePath(chunk.filePath, repositoryId),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
    }));
  const preserved = carriedCitations.filter((citation) =>
    citation.repositoryId === repositoryId &&
    finalizedHybridRanges.some((range) =>
      range.path === citation.relativeFilePath &&
      citation.startLine >= range.startLine &&
      citation.endLine <= range.endLine,
    )
  );
  return buildCitations(
    [
      ...chunks
        .filter((chunk) => chunk.citationRetrievalType !== "hybrid")
        .map((chunk) => ({
          repositoryId,
          filePath: chunk.filePath,
          language: chunk.language,
          chunkId: chunk.chunkId,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          retrievalType: chunk.citationRetrievalType ?? chunk.source,
          score: chunk.score,
          symbol: chunk.symbol,
          repositoryVersion: chunk.repositoryVersion ?? repositoryVersion,
        })),
      ...preserved.map((citation) => ({
        repositoryId: citation.repositoryId,
        filePath: citation.relativeFilePath,
        language: citation.language,
        chunkId: citation.chunkId,
        startLine: citation.startLine,
        endLine: citation.endLine,
        retrievalType: citation.retrievalType,
        score: citation.score,
        symbol: citation.symbol,
        repositoryVersion: citation.repositoryVersion,
      })),
    ],
    { surface: "context" },
  );
}

function dedupe(chunks: EnrichedContextChunk[]): {
  merged: EnrichedContextChunk[];
  removedCount: number;
} {
  const byKey = new Map<string, EnrichedContextChunk>();
  let removedCount = 0;

  for (const chunk of chunks) {
    const key = `${chunk.filePath}:${chunk.startLine}:${chunk.endLine}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...chunk, signals: { ...chunk.signals } });
      continue;
    }
    removedCount += 1;

    // Merge signals: keep max per type.
    for (const k of ["semantic", "keyword", "symbol", "graph", "fileSearch"] as const) {
      const incoming = chunk.signals[k];
      if (incoming !== undefined && incoming > (existing.signals[k] ?? -Infinity)) {
        existing.signals[k] = incoming;
      }
    }
    // Keep highest score (and the winning chunk's content/source).
    if (chunk.score > existing.score) {
      existing.score = chunk.score;
      existing.content = chunk.content;
      existing.source = chunk.source;
      existing.language = chunk.language;
      existing.chunkId = chunk.chunkId ?? existing.chunkId;
      existing.symbol = chunk.symbol ?? existing.symbol;
      existing.citationRetrievalType = chunk.citationRetrievalType;
    }
    existing.symbol ??= chunk.symbol;
    // Preserve any reason.
    if (!existing.reason && chunk.reason) existing.reason = chunk.reason;
  }

  return { merged: [...byKey.values()], removedCount };
}

export function buildRepositorySummaryContextChunk(
  repository: string,
  repositoryVersion: string,
): EnrichedContextChunk | null {
  const summary = getRepositorySummary(repository, { repositoryVersion }) ??
    getRepositorySummary(repository);
  if (!summary) return null;

  const compact = {
    repositoryId: summary.repositoryId,
    purpose: summary.purpose,
    languages: summary.languages.map((entry) => entry.name),
    frameworks: summary.frameworks.map((entry) => entry.name),
    packageManagers: summary.packageManagers.map((entry) => entry.name),
    applications: summary.applications.slice(0, 8),
    services: summary.services.slice(0, 8),
    modules: summary.modules.slice(0, 12),
    entrypoints: summary.entrypoints,
    apiSurface: summary.apiSurface.slice(0, 10),
    dataStores: summary.dataStores.slice(0, 8),
    authentication: summary.authentication.slice(0, 8),
    retrieval: summary.retrieval.slice(0, 8),
    indexing: summary.indexing.slice(0, 8),
    testing: summary.testing.slice(0, 8),
    build: summary.build,
    deployment: summary.deployment,
    dependencyOverview: summary.dependencyOverview,
  };
  const content = `Repository architecture summary:\n${JSON.stringify(compact)}`;
  return {
    filePath: "__repository_summary__",
    language: "text",
    content: content.length <= SUMMARY_CONTEXT_MAX_CHARS
      ? content
      : content.slice(0, SUMMARY_CONTEXT_MAX_CHARS),
    startLine: 1,
    endLine: 1,
    score: 1,
    source: "graph",
    signals: { graph: 1 },
    reason: "Repository architecture summary",
    chunkId: `${repository}:architecture-summary:${summary.repositoryVersion}`,
    symbol: "RepositorySummary",
    repositoryVersion: summary.repositoryVersion,
    citationRetrievalType: "graph",
  };
}

export async function assembleEnrichedContext(
  request: EnrichedAssemblyRequest,
  options: { signal?: AbortSignal; cache?: RetrievalCache } = {},
): Promise<EnrichedAssembledContext> {
  const maxChars = request.maxChars ?? 16_000;
  const limit = request.limit ?? 25;
  const repository = `${request.owner}/${request.repo}`;
  const cache = options.cache ?? runtimeRetrievalCache;

  // A genuinely missing repository is a 404 condition, distinct from a
  // partial source failure (which degrades gracefully below).
  if (!existsSync(repoClonePath(request.owner, request.repo))) {
    throw new Error("Repository not connected");
  }

  let hybridResults: Awaited<ReturnType<typeof hybridSearch>>["results"] = [];
  let hybridCitations: readonly Citation[] = [];
  let repositoryVersion = await cache.repositoryVersion(repository, options.signal);
  const summaryChunk = buildRepositorySummaryContextChunk(repository, repositoryVersion);
  try {
    const res = await hybridSearch({
      query: request.query,
      owner: request.owner,
      repo: request.repo,
      limit: limit * 2,
    }, { signal: options.signal, cache });
    hybridResults = res.results;
    hybridCitations = res.citations ?? [];
    repositoryVersion = res.citations?.[0]?.repositoryVersion ?? repositoryVersion;
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    logger.warn("enriched_hybrid_failed", {
      repository,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  let fileResults: Awaited<ReturnType<typeof searchRepositoryFiles>>["results"] = [];
  try {
    const res = await searchRepositoryFiles({
      query: request.query,
      owner: request.owner,
      repo: request.repo,
      limit: 10,
    });
    fileResults = res.results;
  } catch (err) {
    logger.warn("enriched_file_search_failed", {
      repository,
      message: err instanceof Error ? err.message : "unknown",
    });
  }

  const hybridChunks: EnrichedContextChunk[] = hybridResults.map((r) => ({
    filePath: r.filePath,
    language: r.language,
    content: r.content,
    startLine: r.startLine,
    endLine: r.endLine,
    score: r.score,
    source: r.source,
    signals: r.signals,
    reason: undefined,
    chunkId: r.chunkId,
    symbol: r.symbol,
    repositoryVersion,
    citationRetrievalType: "hybrid",
    primaryQueryMatch: r.primaryQueryMatch,
    queryExpansionMatch: r.queryExpansionMatch,
    stitchedNeighborCount: r.stitchedNeighborCount,
  }));

  const fileChunks: EnrichedContextChunk[] = fileResults.map((r) => ({
    filePath: r.path,
    language: r.language,
    content: `File: ${r.path}\nExports: ${r.symbols.join(", ")}\n${r.reason}`,
    startLine: 1,
    endLine: 1,
    score: r.score * 0.5,
    source: "file-search",
    signals: { fileSearch: r.score },
    reason: r.reason,
    citationRetrievalType: "file-search",
  }));

  const { merged, removedCount } = dedupe([...hybridChunks, ...fileChunks]);

  // Round scores + signals to 3 decimals.
  for (const chunk of merged) {
    chunk.score = round3(chunk.score);
    chunk.signals = roundSignals(chunk.signals);
  }

  // Quality rerank (normalize -> keyword boost -> dedupe -> diversity -> sort)
  // runs AFTER source merge/dedupe and BEFORE character budget trimming.
  const reranked = rerankChunks(merged, request.query);
  const rankedChunks = reranked.chunks;

  // Character budget enforcement with optional trim.
  const finalChunks: EnrichedContextChunk[] = [];
  let usedChars = 0;
  let stitchBudgetDrops = 0;
  if (summaryChunk && summaryChunk.content.length <= maxChars) {
    finalChunks.push(summaryChunk);
    usedChars += summaryChunk.content.length;
  }
  for (const chunk of rankedChunks) {
    const isStitchedHybridChunk = chunk.citationRetrievalType === "hybrid" &&
      hybridCitations.filter((citation) =>
        citation.relativeFilePath === repositoryRelativePath(chunk.filePath, repository) &&
        citation.startLine >= chunk.startLine &&
        citation.endLine <= chunk.endLine
      ).length > 1;
    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      if (isStitchedHybridChunk) stitchBudgetDrops += 1;
      continue;
    }

    if (chunk.content.length <= remaining) {
      finalChunks.push(chunk);
      usedChars += chunk.content.length;
      continue;
    }

    const trimmed = chunk.content.slice(0, TRIM_PREFIX_CHARS) + TRIM_MARKER;
    if (trimmed.length <= remaining) {
      finalChunks.push({ ...chunk, content: trimmed });
      usedChars += trimmed.length;
    }
    else if (isStitchedHybridChunk) {
      stitchBudgetDrops += 1;
    }
    // else: skip chunk, keep scanning for smaller ones.
  }
  recordRuntimeStitchBudgetDrops(stitchBudgetDrops);

  const sourceCounts = {
    semantic: 0,
    keyword: 0,
    symbol: 0,
    graph: 0,
    fileSearch: 0,
  };
  for (const chunk of finalChunks) {
    if (chunk.source === "file-search") sourceCounts.fileSearch += 1;
    else sourceCounts[chunk.source] += 1;
  }

  const totalContentLength = finalChunks.reduce((s, c) => s + c.content.length, 0);
  const estimatedTokens = Math.ceil(totalContentLength / 4);

  const citations = buildContextCitations(
    repository,
    finalChunks,
    repositoryVersion,
    hybridCitations,
  );
  const confidenceBudgetDropCount = Math.max(
    0,
    rankedChunks.length - finalChunks.filter((chunk) =>
      chunk.filePath !== "__repository_summary__"
    ).length,
  );

  const retrievalConfidence = evaluateRuntimeRetrievalConfidence({
    candidates: enrichedChunksToConfidenceCandidates(repository, finalChunks),
    citations,
    budgetDropCount: confidenceBudgetDropCount,
    duplicateSuppressionCount: removedCount + reranked.statistics.duplicateChunksRemoved,
  });

  // Confidence metadata derived from the finalized chunk set (no mutation).
  const confidenceMeta = buildConfidenceMetadata(finalChunks);

  // Developer-facing debug report (metadata only; never affects retrieval).
  const debugReport = buildRetrievalDebugReport(finalChunks, reranked.statistics);

  // Answer provenance (metadata only; which files contributed to the context).
  const answerProvenance = buildAnswerProvenance(finalChunks);

  // Explainability (metadata only; why each chunk was retrieved).
  const explainability = buildRetrievalExplainability(finalChunks);

  // Repository coverage (metadata only; distribution of chunks across files).
  const repositoryCoverage = buildRepositoryCoverage(finalChunks);

  // Retrieval hotspots (metadata only; concentration analysis across files).
  const retrievalHotspots = buildRetrievalHotspots(finalChunks);

  // Retrieval diversity (metadata only; spread of chunks across files).
  const retrievalDiversity = buildRetrievalDiversity(finalChunks);

  // Retrieval blind spots (metadata only; absent sources / file extensions).
  const retrievalBlindSpots = buildRetrievalBlindSpots(finalChunks);

  // Retrieval quality score (metadata only; summary grade from existing
  // metadata layers — never recomputed from chunks).
  const retrievalQualityScore = buildRetrievalQualityScore({
    confidence: confidenceMeta.confidence,
    retrievalDiversity,
    repositoryCoverage,
    retrievalHotspots,
    retrievalBlindSpots,
  });

  logger.info("enriched_context_assembled", {
    query: request.query,
    repository,
    totalChunks: finalChunks.length,
    estimatedTokens,
    hybridInput: hybridResults.length,
    fileSearchInput: fileResults.length,
    deduplicatedCount: removedCount,
  });

  return {
    query: request.query,
    repository,
    totalChunks: finalChunks.length,
    estimatedTokens,
    context: finalChunks,
    citations,
    confidence: toPublicRetrievalConfidence(retrievalConfidence),
    _confidenceBudgetDropCount: confidenceBudgetDropCount,
    stats: {
      hybridResults: hybridResults.length,
      fileSearchResults: fileResults.length,
      deduplicatedCount: removedCount,
      finalCount: finalChunks.length,
      sourceCounts,
      rerank: reranked.statistics,
      confidence: confidenceMeta.confidence,
      chunkConfidence: confidenceMeta.chunkConfidence,
      debugReport,
      answerProvenance,
      explainability,
      repositoryCoverage,
      retrievalHotspots,
      retrievalDiversity,
      retrievalBlindSpots,
      retrievalQualityScore,
    },
  };
}
