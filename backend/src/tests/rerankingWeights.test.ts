import { describe, expect, it } from "vitest";

import {
  calculateRerankScore,
  DEFAULT_RERANKING_WEIGHTS,
} from "../services/retrieval/reranker.js";

describe("reranking weights", () => {
  it("calculates rerank score from weighted signals", () => {
    const score = calculateRerankScore(
      {
        semantic: 1,
        keyword: 1,
        symbol: 1,
        graph: 1,
      },
      "src/plain.ts",
      "export const app = true;",
    );

    expect(score).toBeCloseTo(0.9);
  });

  it("boosts richer content", () => {
    const shortScore = calculateRerankScore(
      {
        semantic: 1,
      },
      "src/plain.ts",
      "short",
    );

    const longScore = calculateRerankScore(
      {
        semantic: 1,
      },
      "src/plain.ts",
      "x".repeat(2500),
    );

    expect(longScore).toBeGreaterThan(shortScore);
  });

  it("exposes default weights", () => {
    expect(DEFAULT_RERANKING_WEIGHTS.semantic).toBe(0.45);
    expect(DEFAULT_RERANKING_WEIGHTS.keyword).toBe(0.25);
    expect(DEFAULT_RERANKING_WEIGHTS.symbol).toBe(0.2);
    expect(DEFAULT_RERANKING_WEIGHTS.graph).toBe(0.1);
  });
});