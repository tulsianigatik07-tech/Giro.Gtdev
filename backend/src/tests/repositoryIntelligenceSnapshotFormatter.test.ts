import { describe, expect, it } from "vitest";

import { buildRepositoryIntelligenceSnapshot } from "../services/repository/repositoryIntelligenceSnapshotFormatter.js";

describe("repository intelligence snapshot formatter", () => {
  it("creates snapshot", () => {
    const snapshot = buildRepositoryIntelligenceSnapshot({
      repositoryId: "demo/repo",
      repositoryName: "demo",
      status: {
        indexed: true,
        architectureReady: true,
        retrievalReady: true,
        ready: true,
      },
      summary: {
        healthScore: 92,
        healthCategory: "excellent",
        hasArchitectureReport: true,
        retrievalGrade: "excellent",
        indexStatus: "indexed",
      },
      analysis: {} as never,
      architecture: {} as never,
      indexing: {} as never,
      intelligence: {
        score: 95,
        grade: "excellent",
      } as never,
      readiness: {
  score: 100,
  level: "excellent",
},
      retrieval: {} as never,
    });

    expect(snapshot.repository).toBe("demo/repo");
    expect(snapshot.intelligenceScore).toBe(95);
    expect(snapshot.indexed).toBe(true);
  });
});