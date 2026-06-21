import type { ArchitectureReviewResult } from "./architectureReviewResult.js";

export function formatArchitectureReview(
  review: ArchitectureReviewResult,
): string {
  const lines: string[] = [];

  lines.push(`Risk Level: ${review.summary.riskLevel}`);
  lines.push(`Coupling Score: ${review.summary.couplingScore}`);
  lines.push("");

  for (const finding of review.findings) {
    lines.push(`[${finding.severity}] ${finding.title}`);
    lines.push(finding.description);
    lines.push(`Recommendation: ${finding.recommendation}`);
    lines.push("");
  }

  return lines.join("\n");
}