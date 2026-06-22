import { describe, expect, it } from "vitest";

import { buildCacheInvalidationPlan } from "../services/repository/cacheInvalidationRules.js";

describe("cache invalidation rules", () => {
  it("invalidates caches when files change", () => {
    const result = buildCacheInvalidationPlan({
      repositoryId: "demo/repo",
      changedFiles: ["a.ts"],
      deletedFiles: [],
    });

    expect(result.invalidateRetrievalCache).toBe(true);
    expect(result.invalidateContextCache).toBe(true);
    expect(result.invalidateArchitectureCache).toBe(true);
    expect(result.invalidateSymbolCache).toBe(true);
  });

  it("does not invalidate caches when nothing changes", () => {
    const result = buildCacheInvalidationPlan({
      repositoryId: "demo/repo",
      changedFiles: [],
      deletedFiles: [],
    });

    expect(result.invalidateRetrievalCache).toBe(false);
    expect(result.invalidateContextCache).toBe(false);
    expect(result.invalidateArchitectureCache).toBe(false);
    expect(result.invalidateSymbolCache).toBe(false);
  });
});