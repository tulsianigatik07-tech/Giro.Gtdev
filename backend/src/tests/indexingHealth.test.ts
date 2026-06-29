import { describe, expect, it } from "vitest";

import { buildRepositoryIndexingHealth } from "../services/repository/indexingHealth.js";

describe("repository indexing health", () => {
  it("returns healthy state for good indexing metrics", () => {
    const health = buildRepositoryIndexingHealth({
      totalFiles: 20,
      totalChunks: 100,
      totalSymbols: 500,
      graphDensity: 2,
    });

    expect(health.healthy).toBe(true);
    expect(health.level).toBe("healthy");
    expect(health.issues).toEqual([]);
  });

  it("returns critical state when indexing data is missing", () => {
    const health = buildRepositoryIndexingHealth({
      totalFiles: 0,
      totalChunks: 0,
      totalSymbols: 0,
      graphDensity: 0,
    });

    expect(health.healthy).toBe(false);
    expect(health.level).toBe("critical");
    expect(health.issues.length).toBeGreaterThan(2);
  });
});