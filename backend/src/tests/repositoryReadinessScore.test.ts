import { describe, expect, it } from "vitest";

import { buildRepositoryReadinessScore } from "../services/repository/repositoryReadinessScore.js";

describe("repository readiness score", () => {
  it("computes readiness score", () => {
    const result = buildRepositoryReadinessScore({
      indexed: true,
      architectureReady: true,
      retrievalReady: true,
      healthScore: 70,
    });

    expect(result.score).toBe(100);
    expect(result.level).toBe("excellent");
  });

  it("returns fair for partially ready repository", () => {
    const result = buildRepositoryReadinessScore({
      indexed: false,
      architectureReady: true,
      retrievalReady: false,
      healthScore: 55,
    });

    expect(result.level).toBe("fair");
  });
});