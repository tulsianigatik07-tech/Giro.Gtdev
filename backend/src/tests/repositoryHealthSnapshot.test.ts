import { describe, expect, it } from "vitest";

import {
  setRepositoryIndexed,
  clearRepositoryIndexRegistry,
} from "../services/repository/indexingService.js";

import { buildRepositoryHealthSnapshot } from "../services/repository/repositoryHealthSnapshot.js";

describe("repository health snapshot", () => {
  it("returns indexed repository state", () => {
    clearRepositoryIndexRegistry();

    setRepositoryIndexed("acme", "demo", {
      chunkCount: 10,
      fileCount: 5,
      symbolCount: 12,
      graphNodeCount: 4,
      graphEdgeCount: 6,
      summaryAvailable: true,
    });

    const snapshot = buildRepositoryHealthSnapshot("acme", "demo");

    expect(snapshot.indexed).toBe(true);
    expect(snapshot.healthy).toBe(true);
    expect(snapshot.status).toBe("indexed");
  });
});