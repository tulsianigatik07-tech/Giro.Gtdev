import { describe, expect, it } from "vitest";

import { buildRepositoryIndexingMetrics } from "../services/repository/indexingMetrics.js";

describe("repository indexing metrics", () => {
  it("computes indexing metrics", () => {
    const metrics = buildRepositoryIndexingMetrics({
      owner: "acme",
      repo: "demo",
      status: "indexed",
      indexedAt: null,
      lastAccessedAt: null,
      chunkCount: 100,
      fileCount: 20,
      symbolCount: 500,
      graphNodeCount: 50,
      graphEdgeCount: 100,
      summaryAvailable: true,
      firstIndexedAt: null,
      lastIndexedAt: null,
      totalIndexedFiles: 20,
      lastIndexMode: "full",
      lastChangedFileCount: 0,
      lastFailureAt: null,
      failureReason: null,
      failedFileCount: 0,
      lastSuccessfulFile: null,
      retryCount: 0,
      lastRetryAt: null,
    });

    expect(metrics.totalFiles).toBe(20);
    expect(metrics.totalChunks).toBe(100);
    expect(metrics.totalSymbols).toBe(500);
    expect(metrics.graphDensity).toBe(2);
  });
});