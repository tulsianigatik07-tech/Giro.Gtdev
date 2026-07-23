import type {
  HybridRetrievalCandidate,
  HybridRetrievalWeights,
} from "./types.js";
import { candidateKey } from "./types.js";

export function scoreRetrievalCandidates(
  candidates: readonly HybridRetrievalCandidate[],
  weights: HybridRetrievalWeights,
): HybridRetrievalCandidate[] {
  for (const candidate of candidates) {
    candidate.baseScore = (
      candidate.signals.semanticSimilarity * weights.semanticSimilarity +
      candidate.signals.lexicalSimilarity * weights.lexicalSimilarity +
      candidate.signals.symbolMatch * weights.symbolMatch +
      candidate.signals.pathSimilarity * weights.pathSimilarity +
      candidate.signals.fileImportance * weights.fileImportance +
      candidate.signals.repositoryImportance * weights.repositoryImportance +
      candidate.signals.dependencyGraphImportance * weights.dependencyGraphImportance +
      candidate.signals.freshness * weights.freshness +
      candidate.signals.revisionMatch * weights.revisionMatch
      + (candidate.signals.graphRelationship ?? 0) * (weights.graphRelationship ?? 0)
    ) * candidate.expansionMultiplier;
    candidate.finalScore = candidate.baseScore;
  }
  return [...candidates].sort((left, right) =>
    right.baseScore - left.baseScore ||
    left.result.filePath.localeCompare(right.result.filePath) ||
    left.result.startLine - right.result.startLine ||
    candidateKey(left).localeCompare(candidateKey(right)));
}

export function applyRerankerScores(
  candidates: readonly HybridRetrievalCandidate[],
  scores: ReadonlyMap<string, number>,
  rerankerWeight: number,
): HybridRetrievalCandidate[] {
  for (const candidate of candidates) {
    candidate.rerankerScore = Math.max(0, Math.min(
      1,
      scores.get(candidateKey(candidate)) ?? candidate.baseScore,
    ));
    candidate.finalScore =
      candidate.baseScore * (1 - rerankerWeight) +
      candidate.rerankerScore * rerankerWeight;
    candidate.result = {
      ...candidate.result,
      score: candidate.finalScore,
      signals: {
        semantic: candidate.signals.semanticSimilarity,
        keyword: Math.max(
          candidate.signals.lexicalSimilarity,
          candidate.signals.pathSimilarity,
        ),
        symbol: candidate.signals.symbolMatch,
        graph: Math.max(
          candidate.signals.dependencyGraphImportance,
          candidate.signals.graphRelationship ?? 0,
        ),
      },
    };
  }
  return [...candidates]
    .sort((left, right) =>
      right.finalScore - left.finalScore ||
      left.result.filePath.localeCompare(right.result.filePath) ||
      left.result.startLine - right.result.startLine ||
      candidateKey(left).localeCompare(candidateKey(right)))
    .map((candidate, index) => {
      candidate.originalRank = index;
      return candidate;
    });
}
