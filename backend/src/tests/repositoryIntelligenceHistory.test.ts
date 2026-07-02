import { describe, expect, it } from "vitest";

import {
  clearRepositoryIntelligenceHistory,
  getRepositoryIntelligenceHistory,
  saveRepositoryIntelligence,
} from "../services/repository/repositoryIntelligenceHistory.js";

describe("repository intelligence history", () => {
  it("stores repository intelligence snapshots", () => {
    clearRepositoryIntelligenceHistory("demo/repo");

    saveRepositoryIntelligence({
      repositoryId: "demo/repo",
      repositoryName: "demo",
      status: {} as never,
      summary: {} as never,
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
      intelligence: {} as never,
      readiness: {
  score: 100,
  level: "excellent",
},
      retrieval: {} as never,
    });

    expect(
      getRepositoryIntelligenceHistory("demo/repo"),
    ).toHaveLength(1);
  });
});