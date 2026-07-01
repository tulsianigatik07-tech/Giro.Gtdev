import { describe, expect, it } from "vitest";

import { buildRepositoryReadinessDashboard } from "../services/repository/repositoryReadinessDashboard.js";

describe("repository readiness dashboard", () => {
  it("builds dashboard view", () => {
    const dashboard = buildRepositoryReadinessDashboard({
      indexed: true,
      architectureReady: true,
      retrievalReady: false,
      healthScore: 80,
    });

    expect(dashboard.score).toBe(100);
    expect(dashboard.level).toBe("excellent");
    expect(dashboard.indexed).toBe(true);
    expect(dashboard.architectureReady).toBe(true);
    expect(dashboard.retrievalReady).toBe(false);
  });
});