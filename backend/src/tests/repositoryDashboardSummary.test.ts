import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRepositoryIndexRegistry,
  setRepositoryIndexed,
} from "../services/repository/indexingService.js";

import { buildRepositoryDashboardSummary } from "../services/repository/repositoryDashboardSummary.js";

describe("repository dashboard summary", () => {
  beforeEach(() => {
    clearRepositoryIndexRegistry();
  });

  it("builds dashboard summary", () => {
    setRepositoryIndexed("acme", "demo", {
      chunkCount: 120,
      fileCount: 18,
      symbolCount: 50,
      graphNodeCount: 20,
      graphEdgeCount: 35,
      summaryAvailable: true,
    });

    const summary = buildRepositoryDashboardSummary(
      "acme",
      "demo",
    );

    expect(summary.repository).toBe("acme/demo");
    expect(summary.status.health.healthy).toBe(true);
    expect(summary.metrics.files).toBe(18);
    expect(summary.metrics.symbols).toBe(50);
  });
});