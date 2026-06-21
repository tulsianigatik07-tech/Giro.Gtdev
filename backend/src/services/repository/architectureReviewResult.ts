import type { ArchitectureQualitySummary } from "./architectureQualitySummary.js";
import type { ArchitectureFinding } from "./architectureFindingTypes.js";

export interface ArchitectureReviewResult {
  summary: ArchitectureQualitySummary;
  findings: readonly ArchitectureFinding[];
  recommendationCount: number;
}