import type { Citation } from "../citations.js";

export const RETRIEVAL_CONFIDENCE_LEVELS = [
  "high",
  "medium",
  "low",
  "insufficient",
] as const;

export type RetrievalConfidenceLevel =
  (typeof RETRIEVAL_CONFIDENCE_LEVELS)[number];

export const RETRIEVAL_CONFIDENCE_REASON_CODES = [
  "strong_top_match",
  "multi_signal_agreement",
  "strong_citation_coverage",
  "cross_file_support",
  "symbol_graph_support",
  "diverse_retrieval_sources",
  "no_retrieval_evidence",
  "weak_top_match",
  "low_score_separation",
  "single_file_dependency",
  "missing_citations",
  "low_citation_coverage",
  "expansion_dependent",
  "summary_only_evidence",
  "excessive_budget_trimming",
  "conflicting_signals",
  "repository_version_unavailable",
] as const;

export type RetrievalConfidenceReasonCode =
  (typeof RETRIEVAL_CONFIDENCE_REASON_CODES)[number];

export const RETRIEVAL_CONFIDENCE_WARNING_CODES = [
  "limited_evidence",
  "citation_metadata_incomplete",
  "expansion_reliant",
  "budget_constrained",
  "repository_version_unverified",
  "repository_version_inconsistent",
] as const;

export type RetrievalConfidenceWarningCode =
  (typeof RETRIEVAL_CONFIDENCE_WARNING_CODES)[number];

export interface RetrievalConfidenceThresholds {
  high: number;
  medium: number;
  low: number;
  minimumCitationCoverage: number;
  minimumAnswerableScore: number;
}

export interface RetrievalConfidenceSignals {
  semantic?: number;
  keyword?: number;
  symbol?: number;
  graph?: number;
}

export interface RetrievalConfidenceCandidate {
  repositoryId: string;
  repositoryVersion?: string;
  filePath: string;
  moduleName?: string;
  startLine: number;
  endLine: number;
  finalScore: number;
  signals?: RetrievalConfidenceSignals;
  retrievalSources?: readonly string[];
  primaryQueryMatch?: boolean;
  queryExpansionMatch?: boolean;
  stitchedNeighborCount?: number;
  repositorySummary?: boolean;
  conflictingSignals?: boolean;
}

export interface RetrievalConfidenceEvidence {
  candidateCount: number;
  citationCount: number;
  uniqueFileCount: number;
  uniqueModuleCount: number;
  retrievalSourceCount: number;
  topScore: number;
  scoreGap: number;
  citationCoverage: number;
  expansionDependencyRatio: number;
  budgetDropCount: number;
}

export interface RetrievalConfidenceResult {
  level: RetrievalConfidenceLevel;
  score: number;
  answerable: boolean;
  reasons: readonly RetrievalConfidenceReasonCode[];
  evidence: Readonly<RetrievalConfidenceEvidence>;
  warnings: readonly RetrievalConfidenceWarningCode[];
}

export interface PublicRetrievalConfidence {
  level: RetrievalConfidenceLevel;
  score: number;
  answerable: boolean;
  reasons: readonly RetrievalConfidenceReasonCode[];
}

export interface RetrievalConfidenceInput {
  candidates: readonly RetrievalConfidenceCandidate[];
  citations: readonly Citation[];
  budgetDropCount?: number;
  duplicateSuppressionCount?: number;
  thresholds: RetrievalConfidenceThresholds;
}

export interface RetrievalConfidenceMetrics {
  incrementRetrievalConfidence(level: RetrievalConfidenceLevel): void;
  incrementRetrievalAnswerability(answerable: boolean): void;
  incrementRetrievalInsufficientEvidence(
    reason: RetrievalConfidenceReasonCode,
  ): void;
}

export interface RetrievalConfidenceLogger {
  info(event: string, fields?: Record<string, unknown>): void;
}
