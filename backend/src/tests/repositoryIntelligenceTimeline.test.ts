import { describe, expect, it } from "vitest";

import {
  clearRepositoryIntelligenceHistory,
  saveRepositoryIntelligence,
} from "../services/repository/repositoryIntelligenceHistory.js";

import { buildRepositoryIntelligenceTimeline } from "../services/repository/repositoryIntelligenceTimeline.js";

describe("repository intelligence timeline", () => {
  it("builds repository intelligence timeline", () => {
    clearRepositoryIntelligenceHistory("demo/repo");

    saveRepositoryIntelligence({
      repositoryId: "demo/repo",
      repositoryName: "demo",
      status: {} as never,
      summary: {
        healthScore: 82,
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

    const timeline =
      buildRepositoryIntelligenceTimeline("demo/repo");

    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.healthScore).toBe(82);
    expect(timeline[0]?.intelligenceScore).toBe(90);
  });
});