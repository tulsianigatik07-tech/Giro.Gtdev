import type { RetrievalQualityScore } from "./retrievalQualityScore.js";

export interface RetrievalReadinessSummary {
  ready: boolean;
  grade: RetrievalQualityScore["grade"];
  score: number;
  reason: string;
}

export function buildRetrievalReadinessSummary(
  quality: RetrievalQualityScore,
): RetrievalReadinessSummary {
  if (quality.score >= 0.7) {
    return {
      ready: true,
      grade: quality.grade,
      score: quality.score,
      reason: "Retrieval quality is ready for reliable context assembly.",
    };
  }

  return {
    ready: false,
    grade: quality.grade,
    score: quality.score,
    reason: "Retrieval quality needs improvement before reliable context assembly.",
  };
}