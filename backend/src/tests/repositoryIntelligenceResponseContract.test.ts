import { describe, expect, it } from "vitest";

import type { RepositoryOverview } from "../services/repository/repositoryOverview.js";
import { buildRepositoryIntelligence } from "../services/repository/repositoryIntelligenceService.js";

describe("repository intelligence response contract", () => {
  it("returns stable intelligence response shape", () => {
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

    expect(result).toHaveProperty("repositoryId");
    expect(result).toHaveProperty("repositoryName");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("analysis");
    expect(result).toHaveProperty("architecture");
    expect(result).toHaveProperty("indexing");
    expect(result).toHaveProperty("intelligence");
    expect(result).toHaveProperty("retrieval");

    expect(result.status).toHaveProperty("indexed");
    expect(result.status).toHaveProperty("architectureReady");
    expect(result.status).toHaveProperty("retrievalReady");
    expect(result.status).toHaveProperty("ready");

    expect(result.summary).toHaveProperty("healthScore");
    expect(result.summary).toHaveProperty("healthCategory");
    expect(result.summary).toHaveProperty("hasArchitectureReport");
    expect(result.summary).toHaveProperty("retrievalGrade");
    expect(result.summary).toHaveProperty("indexStatus");

    expect(result.intelligence).toHaveProperty("score");
    expect(result.intelligence).toHaveProperty("grade");

    expect(result.retrieval).toHaveProperty("context");
    expect(result.retrieval).toHaveProperty("quality");
  });
});