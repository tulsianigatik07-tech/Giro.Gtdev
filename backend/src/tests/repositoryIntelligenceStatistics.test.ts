import { describe, expect, it } from "vitest";

import {
  clearRepositoryIntelligenceHistory,
  saveRepositoryIntelligence,
} from "../services/repository/repositoryIntelligenceHistory.js";

import {
  buildRepositoryIntelligenceStatistics,
} from "../services/repository/repositoryIntelligenceStatistics.js";

describe("repository intelligence statistics", () => {
  it("computes intelligence statistics", () => {
    clearRepositoryIntelligenceHistory("demo/repo");

    saveRepositoryIntelligence({
      repositoryId: "demo/repo",
      repositoryName: "demo",
      status: {} as never,
      summary: {
        healthScore: 80,
      } as never,
      analysis: {} as never,
      architecture: {} as never,
      indexing: {} as never,
      intelligence: {
        score: 90,
      } as never,
      readiness: {
  score: 100,
  level: "excellent",
},
      retrieval: {} as never,
    });

    saveRepositoryIntelligence({
      repositoryId: "demo/repo",
      repositoryName: "demo",
      status: {} as never,
      summary: {
        healthScore: 100,
      } as never,
      analysis: {} as never,
      architecture: {} as never,
      indexing: {} as never,
      intelligence: {
        score: 70,
      } as never,
      readiness: {
  score: 100,
  level: "excellent",
},
      
      retrieval: {} as never,
    });

    const stats =
      buildRepositoryIntelligenceStatistics("demo/repo");

    expect(stats.snapshots).toBe(2);
    expect(stats.averageHealthScore).toBe(90);
    expect(stats.averageIntelligenceScore).toBe(80);
  });
});