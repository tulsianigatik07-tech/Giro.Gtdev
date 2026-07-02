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
        indexing: {
          repository: "",
          status: "unknown",
          indexed: false,
          totalFiles: 0,
          totalChunks: 0,
          totalSymbols: 0,
          totalGraphNodes: 0,
          totalGraphEdges: 0,
          lastIndexedAt: null,
        },
        intelligence: {
          score: 40,
          grade: "poor",
        },
        readiness: {
  score: 100,
  level: "excellent",
},
        retrieval: {} as never,
      });

    expect(recommendations.length).toBeGreaterThan(0);
  });
});