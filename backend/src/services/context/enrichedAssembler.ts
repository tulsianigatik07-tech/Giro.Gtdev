// Enriched context assembler: combines hybrid retrieval + file-level search into
// a single deterministic, budget-bounded context payload. Read-only.

import { hybridSearch } from "../retrieval/hybridSearch.js";
import { searchRepositoryFiles } from "../fileSearch/index.js";
import { rerankChunks } from "../retrieval/qualityReranker.js";
import { buildConfidenceMetadata } from "../retrieval/confidenceScorer.js";
import { repoClonePath } from "../repository/clone.js";
import { logger } from "../../lib/logger.js";
import { existsSync } from "node:fs";
import type {
  EnrichedAssemblyRequest,
  EnrichedAssembledContext,
  EnrichedContextChunk,
} from "./contextTypes.js";

const TRIM_PREFIX_CHARS = 500;
const TRIM_MARKER = "\n/* … trimmed … */";

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
    }
    // Preserve any reason.
    if (!existing.reason && chunk.reason) existing.reason = chunk.reason;
  }

  return { merged: [...byKey.values()], removedCount };
}

export async function assembleEnrichedContext(
  request: EnrichedAssemblyRequest,
): Promise<EnrichedAssembledContext> {
  const maxChars = request.maxChars ?? 16_000;
  const limit = request.limit ?? 25;
  const repository = `${request.owner}/${request.repo}`;

  // A genuinely missing repository is a 404 condition, distinct from a
  // partial source failure (which degrades gracefully below).
  if (!existsSync(repoClonePath(request.owner, request.repo))) {
    throw new Error("Repository not connected");
  }

  let hybridResults: Awaited<ReturnType<typeof hybridSearch>>["results"] = [];
  try {
    const res = await hybridSearch({
      query: request.query,
      owner: request.owner,
      repo: request.repo,
      limit: limit * 2,
    });
    hybridResults = res.results;
  } catch (err) {
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
  for (const chunk of rankedChunks) {
    const remaining = maxChars - usedChars;
    if (remaining <= 0) break;

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
    // else: skip chunk, keep scanning for smaller ones.
  }

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

  // Confidence metadata derived from the finalized chunk set (no mutation).
  const confidenceMeta = buildConfidenceMetadata(finalChunks);

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
    stats: {
      hybridResults: hybridResults.length,
      fileSearchResults: fileResults.length,
      deduplicatedCount: removedCount,
      finalCount: finalChunks.length,
      sourceCounts,
      rerank: reranked.statistics,
      confidence: confidenceMeta.confidence,
      chunkConfidence: confidenceMeta.chunkConfidence,
    },
  };
}
