import { describe, expect, it } from "vitest";

import { buildRetrievalCoverageSummary } from "../services/retrieval/retrievalCoverageSummary.js";

describe("retrieval coverage summary", () => {
  it("returns sufficient coverage", () => {
    const result = buildRetrievalCoverageSummary({
      score: 0.9,
      grade: "excellent",
      factors: {
        confidence: 0.9,
        diversity: 0.8,
        coverage: 0.8,
        hotspotPenalty: 0,
        blindSpotPenalty: 0,
      },
    });

    expect(result.sufficient).toBe(true);
    expect(result.coverage).toBe(0.8);
  });

  it("returns insufficient coverage", () => {
    const result = buildRetrievalCoverageSummary({
      score: 0.4,
      grade: "poor",
      factors: {
        confidence: 0.5,
        diversity: 0.4,
        coverage: 0.3,
        hotspotPenalty: 0.1,
        blindSpotPenalty: 0.1,
      },
    });

    expect(result.sufficient).toBe(false);
    expect(result.coverage).toBe(0.3);
    expect(result.recommendation).toContain("Increase");
  });
});