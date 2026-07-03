import { describe, expect, it } from "vitest";

import { buildRepositoryIndexSummary } from "../services/repository/indexingSummary.js";

describe("indexing summary", () => {
  it("creates repository index summary", () => {
    const summary = buildRepositoryIndexSummary({
      owner: "acme",
      repo: "demo",
      status: "indexed",
      indexedAt: null,
      lastAccessedAt: null,
      chunkCount: 100,
      fileCount: 25,
      symbolCount: 450,
      graphNodeCount: 320,
      graphEdgeCount: 410,
      summaryAvailable: true,
      firstIndexedAt: null,
      lastIndexedAt: null,
      totalIndexedFiles: 25,
      lastIndexMode: "full",
      lastChangedFileCount: 0,
      lastFailureAt: null,
      failureReason: null,
      failedFileCount: 0,
      lastSuccessfulFile: null,
      retryCount: 0,
      lastRetryAt: null,
      lastLifecycleSeverity: null,
lastReindexMode: null,
lastReindexReason: null,
    });

    expect(summary.indexed).toBe(true);
    expect(summary.totalFiles).toBe(25);
    expect(summary.totalSymbols).toBe(450);
  });
});