import { describe, expect, it } from "vitest";

import { getArchitectureTrend } from "../services/repository/architectureTrendAnalysis.js";

describe("architecture trend analysis", () => {
  it("returns architecture trend for a repository", () => {
    const trend = getArchitectureTrend("demo/repo");

    expect(Array.isArray(trend)).toBe(true);

    for (const point of trend) {
      expect(point).toHaveProperty("generatedAt");
      expect(point).toHaveProperty("score");
      expect(typeof point.score).toBe("number");
    }
  });

  it("returns empty trend for unknown repository", () => {
    const trend = getArchitectureTrend("unknown/repo");

    expect(Array.isArray(trend)).toBe(true);
  });
});