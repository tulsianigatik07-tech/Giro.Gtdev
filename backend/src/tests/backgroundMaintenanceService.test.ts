import { describe, expect, it } from "vitest";

import { runBackgroundMaintenanceJobs } from "../services/repository/backgroundMaintenanceService.js";

describe("background maintenance jobs", () => {
  it("returns maintenance result", () => {
    const result = runBackgroundMaintenanceJobs();

    expect(result).toHaveProperty("sessionsCleaned");
    expect(typeof result.sessionsCleaned).toBe("number");
  });
});