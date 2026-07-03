import { describe, expect, it } from "vitest";

import { buildRepositoryIntelligenceApiResponse } from "../services/repository/repositoryIntelligenceApiResponse.js";

describe("repository intelligence api response", () => {
  it("builds api response", () => {
    const response = buildRepositoryIntelligenceApiResponse({
      repositoryId: "demo/repo",
      repositoryName: "demo",

      status: {
        indexed: true,
        architectureReady: true,
        retrievalReady: true,
        ready: true,
      },

      summary: {
        healthScore: 90,
        healthCategory: "excellent",
        hasArchitectureReport: true,
        retrievalGrade: "A",
        indexStatus: "indexed",
      },

      analysis: {} as never,
      architecture: {} as never,
      indexing: {} as never,

      intelligence: {
        score: 95,
        grade: "A",
      } as never,

      readiness: {
        score: 100,
        level: "excellent",
      },

      retrieval: {
        context: {} as never,
        quality: {} as never,
        indexingReport: {} as never,
      },
    });

    expect(response.repository.id).toBe("demo/repo");
    expect(response.intelligence.score).toBe(95);
    expect(response.readiness.level).toBe("excellent");
    expect(response.status.ready).toBe(true);
  });
});