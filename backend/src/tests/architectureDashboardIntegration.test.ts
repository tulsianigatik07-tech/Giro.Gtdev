import { describe, expect, it } from "vitest";

import { getArchitectureDashboardData } from "../services/repository/architectureDashboardIntegration.js";

describe("architecture dashboard integration", () => {
  it("returns dashboard data object", () => {
    const result = getArchitectureDashboardData("demo/repo");

    expect(result.repositoryId).toBe("demo/repo");
    expect(result).toHaveProperty("hasReport");
    expect(result).toHaveProperty("report");
  });

  it("returns boolean hasReport flag", () => {
    const result = getArchitectureDashboardData("unknown/repo");

    expect(typeof result.hasReport).toBe("boolean");
  });
});