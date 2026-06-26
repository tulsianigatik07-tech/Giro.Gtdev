import { describe, expect, it } from "vitest";

import {
  clearRepositoryIntelligenceHistory,
  saveRepositoryIntelligence,
} from "../services/repository/repositoryIntelligenceHistory.js";
import { getRepositoryIntelligenceTrend } from "../services/repository/repositoryIntelligenceTrend.js";

describe("repository intelligence trend", () => {
  it("builds trend points from intelligence history", () => {
    clearRepositoryIntelligenceHistory("demo/repo");

    saveRepositoryIntelligence({
      repositoryId: "demo/repo",
      repositoryName: "demo",
      status: {} as never,
      summary: {} as never,
      analysis: {} as never,
      architecture: {} as never,
      indexing: null,
      intelligence: {
        score: 88,
        grade: "excellent",
      },
      retrieval: {} as never,
    });

    const trend = getRepositoryIntelligenceTrend("demo/repo");

    expect(trend).toHaveLength(1);
    expect(trend[0]?.score).toBe(88);
    expect(trend[0]?.grade).toBe("excellent");
  });
});