import { describe, expect, it } from "vitest";

import { buildRepositoryAnalysisReport } from "../services/repository/repositoryAnalysisReport.js";

describe("repository analysis report", () => {
  it("builds a repository analysis report", () => {
    const report = buildRepositoryAnalysisReport({
      repositoryName: "demo-repo",
      health: {
        summary: {
          scale: "large",
          complexity: "high",
          fileCoverage: 1,
          dependencyDensity: 10,
          healthScore: 40,
          healthCategory: "poor",
        },
        recommendations: ["Reduce dependency density"],
      },
      overview: "Repository overview",
      structureSummary: "Repository structure",
    });

    expect(report.repositoryName).toBe("demo-repo");
    expect(report.health.recommendations.length).toBe(1);
  });
});