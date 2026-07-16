import { env } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import { runtimeMetrics } from "../../../observability/metrics.js";
import { evaluateRetrievalConfidence } from "./retrievalConfidence.js";
import type {
  RetrievalConfidenceInput,
  RetrievalConfidenceLogger,
  RetrievalConfidenceMetrics,
  RetrievalConfidenceReasonCode,
  RetrievalConfidenceResult,
  RetrievalConfidenceThresholds,
} from "./confidenceTypes.js";

export const runtimeRetrievalConfidenceThresholds: Readonly<RetrievalConfidenceThresholds> =
  Object.freeze({
    high: env.RETRIEVAL_CONFIDENCE_HIGH_THRESHOLD,
    medium: env.RETRIEVAL_CONFIDENCE_MEDIUM_THRESHOLD,
    low: env.RETRIEVAL_CONFIDENCE_LOW_THRESHOLD,
    minimumCitationCoverage: env.RETRIEVAL_MIN_CITATION_COVERAGE,
    minimumAnswerableScore: env.RETRIEVAL_MIN_ANSWERABLE_SCORE,
  });

export interface RuntimeRetrievalConfidenceOptions {
  metrics?: RetrievalConfidenceMetrics;
  logger?: RetrievalConfidenceLogger;
  thresholds?: RetrievalConfidenceThresholds;
  now?: () => number;
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(60_000, Math.max(0, value)));
}

function negativeReasons(
  result: RetrievalConfidenceResult,
): RetrievalConfidenceReasonCode[] {
  return result.reasons.filter((reason) => ![
    "strong_top_match",
    "multi_signal_agreement",
    "strong_citation_coverage",
    "cross_file_support",
    "symbol_graph_support",
    "diverse_retrieval_sources",
  ].includes(reason));
}

function safeFields(
  result: RetrievalConfidenceResult,
  durationMs: number,
): Record<string, unknown> {
  return {
    level: result.level,
    answerable: result.answerable,
    candidateCount: result.evidence.candidateCount,
    citationCount: result.evidence.citationCount,
    uniqueFileCount: result.evidence.uniqueFileCount,
    retrievalSourceCount: result.evidence.retrievalSourceCount,
    reasonCodes: [...result.reasons].slice(0, 12),
    durationMs,
  };
}

export function evaluateRuntimeRetrievalConfidence(
  input: Omit<RetrievalConfidenceInput, "thresholds"> & {
    thresholds?: RetrievalConfidenceThresholds;
  },
  options: RuntimeRetrievalConfidenceOptions = {},
): RetrievalConfidenceResult {
  const confidenceMetrics = options.metrics ?? runtimeMetrics;
  const confidenceLogger = options.logger ?? logger;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const result = evaluateRetrievalConfidence({
    ...input,
    thresholds: input.thresholds ?? options.thresholds ?? runtimeRetrievalConfidenceThresholds,
  });
  const durationMs = boundedDuration(now() - startedAt);

  confidenceMetrics.incrementRetrievalConfidence(result.level);
  confidenceMetrics.incrementRetrievalAnswerability(result.answerable);
  confidenceLogger.info("retrieval_confidence_evaluated", safeFields(result, durationMs));

  if (result.level === "low") {
    confidenceLogger.info("retrieval_low_confidence", safeFields(result, durationMs));
  }
  if (!result.answerable) {
    const reasons = negativeReasons(result);
    for (const reason of reasons) {
      confidenceMetrics.incrementRetrievalInsufficientEvidence(reason);
    }
    confidenceLogger.info("retrieval_evidence_insufficient", safeFields(result, durationMs));
  }
  return result;
}

export function recordRuntimeAnswerSuppressed(
  result: RetrievalConfidenceResult,
  options: Pick<RuntimeRetrievalConfidenceOptions, "logger"> = {},
): void {
  (options.logger ?? logger).info(
    "retrieval_answer_suppressed",
    safeFields(result, 0),
  );
}
