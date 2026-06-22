import { describe, expect, it } from "vitest";

import {
  assessArchitectureRisk,
} from "./architectureRiskLevel.js";

describe("architecture risk level", () => {
  it("returns LOW risk", () => {
    const result = assessArchitectureRisk({
      score: 10,
      level: "LOW",
    });

    expect(result.level).toBe("LOW");
  });

  it("returns MEDIUM risk", () => {
    const result = assessArchitectureRisk({
      score: 50,
      level: "MEDIUM",
    });

    expect(result.level).toBe("MEDIUM");
  });

  it("returns HIGH risk", () => {
    const result = assessArchitectureRisk({
      score: 90,
      level: "HIGH",
    });

    expect(result.level).toBe("HIGH");
  });
});