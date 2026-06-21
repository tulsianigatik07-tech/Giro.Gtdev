import type { ArchitectureQualitySummary } from "./architectureQualitySummary.js";
import { reviewArchitecture } from "./architectureReviewEngine.js";
import { formatArchitectureReview } from "./architectureReviewFormatter.js";

export function runArchitectureReview(
  summary: ArchitectureQualitySummary,
): string {
  const review = reviewArchitecture(summary);

  return formatArchitectureReview(review);
}