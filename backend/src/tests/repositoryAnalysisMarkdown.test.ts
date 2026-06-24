import { describe, expect, it } from "vitest";

import { buildRepositoryAnalysisMarkdown } from "../services/repository/repositoryAnalysisMarkdown.js";

describe("repository analysis markdown", () => {
  it("formats repository analysis report", () => {
    const markdown = buildRepositoryAnalysisMarkdown({
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
        recommendations: [
          "Reduce dependency density",
        ],
      },
      overview: "Repository overview",
      structureSummary: "Repository structure",
    });

    expect(markdown).toContain("# demo-repo");
    expect(markdown).toContain("Reduce dependency density");
  });
});