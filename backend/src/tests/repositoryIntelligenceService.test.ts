import { describe, expect, it } from "vitest";

import type { RepositoryOverview } from "../services/repository/repositoryOverview.js";
import { buildRepositoryIntelligence } from "../services/repository/repositoryIntelligenceService.js";


describe("repository intelligence service", () => {
  it("builds repository intelligence response", () => {
    const overview = {
      structure: {
        totalFiles: 10,
        totalSymbols: 20,
        repositoryScale: "small",
      },
      architecture: {
        totalFiles: 10,
        totalDependencies: 15,
        architectureComplexity: "medium",
      },
    } as RepositoryOverview;

    const result = buildRepositoryIntelligence({
      repositoryId: "demo/repo",
      repositoryName: "demo-repo",
      overview,
    });

    expect(result.repositoryId).toBe("demo/repo");
    expect(result.repositoryName).toBe("demo-repo");
    expect(result.analysis.repositoryName).toBe("demo-repo");
    expect(result.architecture.repositoryId).toBe("demo/repo");
    expect(result.retrieval.context.totalFiles).toBe(10);
    expect(result.retrieval.quality.grade).toBe("poor");
    expect(result.summary).toHaveProperty("retrievalGrade");
    expect(result.status.retrievalReady).toBe(false);
    expect(result.indexing.status).toBe("unknown");
    expect(result.indexing.indexed).toBe(false);
    expect(result.summary.indexStatus).toBe("unknown");
    expect(result.status.indexed).toBe(false);
    expect(result.retrieval.indexingReport.metrics.totalFiles).toBe(0);
    expect(result.retrieval.indexingReport.health.healthy).toBe(false);
  });
});