import type { CircularDependency } from "./architectureCircularDependencyDetector.js";
import type { ArchitectureLayerViolation } from "./architectureLayerViolationDetector.js";

export interface ArchitectureHealthScoreInput {
  circularDependencies: readonly CircularDependency[];
  layerViolations: readonly ArchitectureLayerViolation[];
}

export interface ArchitectureHealthScore {
  score: number;
  circularDependencyCount: number;
  layerViolationCount: number;
  summary: string;
}

export function calculateArchitectureHealthScore(
  input: ArchitectureHealthScoreInput,
): ArchitectureHealthScore {
  const circularPenalty = input.circularDependencies.length * 10;
  const layerViolationPenalty = input.layerViolations.length * 5;

  const score = Math.max(
    0,
    100 - circularPenalty - layerViolationPenalty,
  );

  return {
    score,
    circularDependencyCount: input.circularDependencies.length,
    layerViolationCount: input.layerViolations.length,
    summary: `Architecture health score is ${score}/100`,
  };
}
