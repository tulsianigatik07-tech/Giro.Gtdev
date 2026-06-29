import { describe, expect, it } from "vitest";

import { buildRetrievalReadinessSummary } from "../services/retrieval/readinessSummary.js";

describe("retrieval readiness summary", () => {
  it("marks strong retrieval quality as ready", () => {
    const result = buildRetrievalReadinessSummary({
      score: 0.8,
      grade: "good",
      factors: {
        confidence: 0.9,
        diversity: 0.8,
        coverage: 0.7,
        hotspotPenalty: 0,
        blindSpotPenalty: 0,
      },
    });

    expect(result.ready).toBe(true);
  });

  it("marks weak retrieval quality as not ready", () => {
    const result = buildRetrievalReadinessSummary({
      score: 0.4,
      grade: "poor",
      factors: {
        confidence: 0.4,
        diversity: 0.4,
        coverage: 0.2,
        hotspotPenalty: 0.1,
        blindSpotPenalty: 0.1,
      },
    });

    expect(result.ready).toBe(false);
  });
});