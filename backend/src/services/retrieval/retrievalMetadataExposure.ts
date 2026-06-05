// Pure pass-through mapper that surfaces retrieval metadata ALREADY produced by
// enrichedAssembler (on EnrichedAssembledContext.stats) into the ask response.
// Never recomputes; only forwards existing values. Inputs are never mutated.
// Only keys actually present on stats are included (no undefined emitted).

import type { EnrichedAssembledContext } from "../context/contextTypes.js";
import type { ChunkConfidence } from "./confidenceScorer.js";
import type { RetrievalDebugReport } from "./debugReport.js";
import type { AnswerProvenance } from "./answerProvenance.js";
import type { RerankStatistics } from "./qualityReranker.js";

export interface RetrievalMetadata {
  confidence?: number;
  chunkConfidence?: ChunkConfidence[];
  debugReport?: RetrievalDebugReport;
  answerProvenance?: AnswerProvenance;
  rerank?: RerankStatistics;
}

export function buildRetrievalMetadata(
  stats: EnrichedAssembledContext["stats"],
): RetrievalMetadata {
  const out: RetrievalMetadata = {};
  if (stats.confidence !== undefined) out.confidence = stats.confidence;
  if (stats.chunkConfidence !== undefined) out.chunkConfidence = stats.chunkConfidence;
  if (stats.debugReport !== undefined) out.debugReport = stats.debugReport;
  if (stats.answerProvenance !== undefined) out.answerProvenance = stats.answerProvenance;
  if (stats.rerank !== undefined) out.rerank = stats.rerank;
  return out;
}
