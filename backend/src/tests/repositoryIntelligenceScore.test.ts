import { describe, expect, it } from "vitest";

import { buildRepositoryIntelligenceScore } from "../services/repository/repositoryIntelligenceScore.js";

describe("repository intelligence score", () => {
  it("builds excellent score for strong signals", () => {
    const result = buildRepositoryIntelligenceScore({
      healthScore: 95,
      indexed: true,
      architectureReady: true,
      retrievalScore: 1,
    });

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.grade).toBe("excellent");
  });

  it("builds poor score for missing signals", () => {
    const result = buildRepositoryIntelligenceScore({
      healthScore: 20,
      indexed: false,
      architectureReady: false,
      retrievalScore: 0,
    });

    expect(result.grade).toBe("poor");
  });
});