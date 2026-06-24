import type { RepositoryAnalysisReport } from "./repositoryAnalysisReport.js";

export function buildRepositoryAnalysisMarkdown(
  report: RepositoryAnalysisReport,
): string {
  return [
    `# ${report.repositoryName}`,
    "",
    "## Health",
    `Score: ${report.health.summary.healthScore}`,
    `Category: ${report.health.summary.healthCategory}`,
    "",
    "## Recommendations",
    ...report.health.recommendations.map((r) => `- ${r}`),
    "",
    "## Overview",
    report.overview,
    "",
    "## Structure",
    report.structureSummary,
  ].join("\n");
}