import { describe, expect, it } from "vitest";

import { buildRepositoryHealthBadge } from "../services/repository/repositoryHealthBadge.js";

describe("repository health badge", () => {
  it("returns excellent badge", () => {
    expect(
      buildRepositoryHealthBadge({
        scale: "small",
        complexity: "low",
        fileCoverage: 1,
        dependencyDensity: 1,
        healthScore: 95,
        healthCategory: "excellent",
      }),
    ).toBe("EXCELLENT");
  });

  it("returns poor badge", () => {
    expect(
      buildRepositoryHealthBadge({
        scale: "large",
        complexity: "high",
        fileCoverage: 1,
        dependencyDensity: 10,
        healthScore: 40,
        healthCategory: "poor",
      }),
    ).toBe("POOR");
  });
});