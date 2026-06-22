import type { ArchitectureReviewResult } from "./architectureReviewResult.js";

export function exportArchitectureMarkdown(
  review: ArchitectureReviewResult,
): string {
  const findingsSection =
    review.findings.length === 0
      ? "- No findings"
      : review.findings
          .map(
            (finding) =>
              `- ${finding.title}: ${finding.description}`,
          )
          .join("\n");

  return [
    "# Architecture Review Report",
    "",
    `Risk Level: ${review.summary.riskLevel}`,
    `Coupling Level: ${review.summary.couplingLevel}`,
    `Coupling Score: ${review.summary.couplingScore}`,
    "",
    "## Summary",
    "",
    review.summary.summary,
    "",
    "## Findings",
    "",
    findingsSection,
    "",
    `Recommendations: ${review.recommendationCount}`,
  ].join("\n");
}