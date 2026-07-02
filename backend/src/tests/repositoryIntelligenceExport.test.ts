import { describe, expect, it } from "vitest";

import { exportRepositoryIntelligence } from "../services/repository/repositoryIntelligenceExport.js";

describe("repository intelligence export", () => {
  it("exports compact intelligence payload", () => {
    const result = exportRepositoryIntelligence({
      repositoryId: "demo/repo",
      repositoryName: "demo",
      status: {
        indexed: true,
        architectureReady: true,
        retrievalReady: true,
        ready: true,
      },
      summary: {
        healthScore: 90,
        healthCategory: "excellent",
        hasArchitectureReport: true,
        retrievalGrade: "good",
        indexStatus: "indexed",
      },
      intelligence: {
        score: 88,
        grade: "excellent",
      },
      analysis: {} as never,
      architecture: {} as never,
      indexing: {
          repository: "",
          status: "unknown",
          indexed: false,
          totalFiles: 0,
          totalChunks: 0,
          totalSymbols: 0,
          totalGraphNodes: 0,
          totalGraphEdges: 0,
          lastIndexedAt: null,
        },
      readiness: {
  score: 100,
  level: "excellent",
},  
      retrieval: {} as never,
    });

    expect(result.repositoryId).toBe("demo/repo");
    expect(result.intelligenceScore).toBe(88);
    expect(result.indexStatus).toBe("indexed");
    expect(result.architectureReady).toBe(true);
  });
});