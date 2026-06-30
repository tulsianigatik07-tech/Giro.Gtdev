import type { RetrievalQualityScore } from "./retrievalQualityScore.js";

export interface RetrievalCoverageSummary {
  coverage: number;
  sufficient: boolean;
  recommendation: string;
}

export function buildRetrievalCoverageSummary(
  quality: RetrievalQualityScore,
): RetrievalCoverageSummary {
  const coverage = quality.factors.coverage;

  return {
    coverage,
    sufficient: coverage >= 0.7,
    recommendation:
      coverage >= 0.7
        ? "Repository coverage is sufficient."
        : "Increase repository coverage before answering complex questions.",
  };
}