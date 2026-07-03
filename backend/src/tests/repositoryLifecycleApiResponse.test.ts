import { describe, expect, it } from "vitest";

import { buildRepositoryLifecycleApiResponse } from "../services/repository/repositoryLifecycleApiResponse.js";
import { buildRepositoryLifecycleDashboard } from "../services/repository/repositoryLifecycleDashboard.js";
import { buildRepositoryLifecycleReport } from "../services/repository/repositoryLifecycleReport.js";

describe("repository lifecycle api response", () => {
  it("builds lifecycle api response", () => {
    const report = buildRepositoryLifecycleReport({
      added: 3,
      modified: 5,
      deleted: 2,
    });

    const dashboard = buildRepositoryLifecycleDashboard(report);

    const response = buildRepositoryLifecycleApiResponse(
      report,
      dashboard,
    );

    expect(response.lifecycle.totalChanges).toBe(10);
    expect(response.lifecycle.reindexMode).toBe("incremental");
    expect(response.metadata.version).toBe("v1");
    expect(response.metadata.generatedAt).toBeTruthy();
  });
});