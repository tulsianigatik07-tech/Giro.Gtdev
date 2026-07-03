import { describe, expect, it } from "vitest";

import { buildRepositoryIndexingReport } from "../services/repository/indexingReport.js";

describe("repository indexing report", () => {
  it("builds indexing report", () => {
    const report = buildRepositoryIndexingReport({
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
      lastLifecycleSeverity: null,
lastReindexMode: null,
lastReindexReason: null,
    });

    expect(report.metrics.totalFiles).toBe(20);
    expect(report.health.healthy).toBe(true);
  });
});