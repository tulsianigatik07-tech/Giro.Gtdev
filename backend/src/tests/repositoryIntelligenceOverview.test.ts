import { describe, expect, it } from "vitest";

import { buildRepositoryIntelligenceOverview } from "../services/repository/repositoryIntelligenceOverview.js";

describe("repository intelligence overview", () => {
  it("builds overview", () => {
    const overview = buildRepositoryIntelligenceOverview({
      repositoryId: "demo/repo",
      repositoryName: "demo",
      status: {
        indexed: true,
        architectureReady: true,
        retrievalReady: true,
        ready: true,
      },
      summary: {
        healthScore: 91,
        healthCategory: "excellent",
        hasArchitectureReport: true,
        retrievalGrade: "excellent",
        indexStatus: "indexed",
      },
      analysis: {} as never,
      architecture: {} as never,
      indexing: {} as never,
      intelligence: {
        score: 96,
        grade: "excellent",
      } as never,
      readiness: {
  score: 100,
  level: "excellent",
},
      retrieval: {} as never,
    });

    expect(overview.repositoryId).toBe("demo/repo");
    expect(overview.intelligenceScore).toBe(96);
    expect(overview.healthScore).toBe(91);
    expect(overview.ready).toBe(true);
  });
});