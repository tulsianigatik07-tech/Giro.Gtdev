import { describe, expect, it } from "vitest";

import { buildRepositoryIntelligenceRecommendations } from "../services/repository/repositoryIntelligenceRecommendations.js";

describe("repository intelligence recommendations", () => {
  it("returns recommendations for an unhealthy repository", () => {
    const recommendations =
      buildRepositoryIntelligenceRecommendations({
        repositoryId: "demo/repo",
        repositoryName: "demo",
        status: {
          indexed: false,
          architectureReady: false,
          retrievalReady: false,
          ready: false,
        },
        summary: {} as never,
        analysis: {} as never,
        architecture: {} as never,
        indexing: null,
        intelligence: {
          score: 40,
          grade: "poor",
        },
        retrieval: {} as never,
      });

    expect(recommendations.length).toBeGreaterThan(0);
  });
});