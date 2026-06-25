import { describe, expect, it } from "vitest";

import { generateArchitectureRecommendations } from "../services/repository/architectureRecommendationEngine.js";

describe("architecture recommendation engine", () => {
  it("generates recommendations for high risk architecture", () => {
    const result = generateArchitectureRecommendations({
      riskLevel: "HIGH",
    } as never);

    expect(result).toContain("Reduce coupling between internal modules");
    expect(result).toContain(
      "Break large dependency chains into smaller components",
    );
  });

  it("generates recommendation for medium risk architecture", () => {
    const result = generateArchitectureRecommendations({
      riskLevel: "MEDIUM",
    } as never);

    expect(result).toEqual([
      "Review module boundaries for tighter separation",
    ]);
  });

  it("generates recommendation for low risk architecture", () => {
    const result = generateArchitectureRecommendations({
      riskLevel: "LOW",
    } as never);

    expect(result).toEqual([
      "Maintain current architectural structure",
    ]);
  });
});