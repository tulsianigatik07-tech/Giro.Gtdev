import { describe, expect, it } from "vitest";

import { buildRepositoryIntelligenceHealthSummary } from "../services/repository/repositoryIntelligenceHealthSummary.js";

describe("repository intelligence health summary", () => {
  it("builds health summary", () => {
    const summary = buildRepositoryIntelligenceHealthSummary({
      repositoryId: "demo/repo",
      repositoryName: "demo",
      status: {
        indexed: true,
        architectureReady: true,
        retrievalReady: true,
        ready: true,
      },
      summary: {
        healthScore: 82,
        healthCategory: "good",
        hasArchitectureReport: true,
        retrievalGrade: "A",
        indexStatus: "indexed",
      },
      analysis: {} as never,
      architecture: {} as never,
      indexing: {} as never,
      intelligence: {
        score: 91,
        grade: "A",
      } as never,
      readiness: {
        score: 92,
        level: "excellent",
      },
      retrieval: {} as never,
    });

    expect(summary.intelligenceScore).toBe(91);
    expect(summary.readinessScore).toBe(92);
    expect(summary.healthScore).toBe(82);
    expect(summary.ready).toBe(true);
  });
});