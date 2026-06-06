// Pure pass-through mapper that surfaces retrieval metadata ALREADY produced by
// enrichedAssembler (on EnrichedAssembledContext.stats) into the ask response.
// Never recomputes; only forwards existing values. Inputs are never mutated.
// Only keys actually present on stats are included (no undefined emitted).

import type { EnrichedAssembledContext } from "../context/contextTypes.js";
import type { ChunkConfidence } from "./confidenceScorer.js";
import type { RetrievalDebugReport } from "./debugReport.js";
import type { AnswerProvenance } from "./answerProvenance.js";
import type { RerankStatistics } from "./qualityReranker.js";
import type { RetrievalExplainability } from "./explainability.js";
import type { RepositoryCoverage } from "./repositoryCoverage.js";
import type { RetrievalHotspots } from "./retrievalHotspots.js";
import type { RetrievalDiversity } from "./retrievalDiversity.js";
import type { RetrievalBlindSpots } from "./retrievalBlindSpots.js";

export interface RetrievalMetadata {
  confidence?: number;
  chunkConfidence?: ChunkConfidence[];
  debugReport?: RetrievalDebugReport;
  answerProvenance?: AnswerProvenance;
  rerank?: RerankStatistics;
  explainability?: RetrievalExplainability;
  repositoryCoverage?: RepositoryCoverage;
  retrievalHotspots?: RetrievalHotspots;
  retrievalDiversity?: RetrievalDiversity;
  retrievalBlindSpots?: RetrievalBlindSpots;
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
  if (stats.explainability !== undefined) out.explainability = stats.explainability;
  if (stats.repositoryCoverage !== undefined) out.repositoryCoverage = stats.repositoryCoverage;
  if (stats.retrievalHotspots !== undefined) out.retrievalHotspots = stats.retrievalHotspots;
  if (stats.retrievalDiversity !== undefined) out.retrievalDiversity = stats.retrievalDiversity;
  if (stats.retrievalBlindSpots !== undefined) out.retrievalBlindSpots = stats.retrievalBlindSpots;
  return out;
}
