import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRepositoryIndexRegistry,
  setRepositoryIndexed,
} from "../services/repository/indexingService.js";

import { buildRepositoryReadinessSnapshot } from "../services/repository/repositoryReadinessSnapshot.js";

describe("repository readiness snapshot", () => {
  beforeEach(() => {
    clearRepositoryIndexRegistry();
  });

  it("builds readiness snapshot", () => {
    setRepositoryIndexed("acme", "demo", {
      chunkCount: 120,
      fileCount: 18,
      symbolCount: 42,
      graphNodeCount: 20,
      graphEdgeCount: 35,
      summaryAvailable: true,
    });

    const snapshot = buildRepositoryReadinessSnapshot(
      "acme",
      "demo",
    );

    expect(snapshot.ready).toBe(true);
    expect(snapshot.status).toBe("indexed");
    expect(snapshot.indexedFiles).toBe(18);
    expect(snapshot.indexedChunks).toBe(120);
  });

  it("returns missing snapshot", () => {
    const snapshot = buildRepositoryReadinessSnapshot(
      "unknown",
      "repo",
    );

    expect(snapshot.ready).toBe(false);
    expect(snapshot.status).toBe("missing");
  });
});