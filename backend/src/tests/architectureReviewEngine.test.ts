import { describe, expect, it } from "vitest";

import { reviewArchitecture } from "../services/repository/architectureReviewEngine.js";

describe("architecture review engine", () => {
  it("returns findings and recommendation count", () => {
    const summary = {
      overallScore: 60,
      couplingScore: 45,
      circularDependencyCount: 2,
      layerViolationCount: 1,
      architectureHealth: "warning",
    };

    const result = reviewArchitecture(summary as never);

    expect(result.summary).toBe(summary);
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.recommendationCount).toBe(result.findings.length);
  });

  it("handles healthy architecture", () => {
    const summary = {
      overallScore: 100,
      couplingScore: 100,
      circularDependencyCount: 0,
      layerViolationCount: 0,
      architectureHealth: "healthy",
    };

    const result = reviewArchitecture(summary as never);

    expect(result.recommendationCount).toBeGreaterThanOrEqual(0);
  });
});