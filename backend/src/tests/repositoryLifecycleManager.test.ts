import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRepositoryFileSnapshots,
  getRepositoryFileSnapshot,
  saveRepositoryFileSnapshot,
} from "../services/repository/fileSnapshotStore.js";
import {
  clearGraphSourceStore,
  getFileSymbolMaps,
  setFileSymbolMap,
} from "../services/repository/graphSourceStore.js";
import {
  clearRepositoryIndexRegistry,
  getRepositoryIndexMetadata,
  setRepositoryIndexed,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import {
  clearRepositoryOwners,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";
import {
  cleanupRepository,
  connectRepository,
  getRepositorySummary,
} from "../services/repository/repositoryLifecycleManager.js";
import {
  clearRepositoryIntelligenceHistory,
} from "../services/repository/repositoryIntelligenceHistory.js";
import {
  clearRepositorySymbolIndex,
  getRepositorySymbols,
  saveRepositorySymbols,
} from "../services/repository/symbolIndexStore.js";
import { getSessionById } from "../services/sessions/sessionService.js";
import { clearAllSessions, createSession } from "../services/sessions/store.js";
import type { FileSymbolMap } from "../services/graph/types.js";
import type { ScannedFile } from "../services/repository/scanner.js";
import type { Session } from "../services/sessions/types.js";

const OWNER = "acme";
const REPO = "demo";
const REPO_ID = `${OWNER}/${REPO}`;
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

const COUNTS: IndexedCounts = {
  chunkCount: 4,
  fileCount: 2,
  symbolCount: 2,
  graphNodeCount: 2,
  graphEdgeCount: 1,
  summaryAvailable: true,
};

function scanned(filePath: string): ScannedFile {
  return {
    filePath,
    size: 10,
    language: "typescript",
  };
}

function fileMap(filePath: string, symbolName: string, line: number): FileSymbolMap {
  return {
    filePath,
    language: "typescript",
    symbols: [
      {
        name: symbolName,
        kind: "function",
        exported: true,
        line,
      },
    ],
    imports: [],
  };
}

function session(id: string, owner = OWNER, repo = REPO): Session {
  return {
    id,
    userId: "user-a",
    owner,
    repo,
    title: `${owner}/${repo}`,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    messages: [],
    selectedContext: [],
  };
}

function seedRepository(): void {
  setRepositoryOwner(REPO_ID, "user-a");
  setRepositoryIndexed(OWNER, REPO, COUNTS);
  saveRepositoryFileSnapshot(REPO_ID, [
    scanned("src/z.ts"),
    scanned("src/a.ts"),
  ]);
  saveRepositorySymbols(REPO_ID, [
    {
      filePath: "src/z.ts",
      symbolName: "zeta",
      kind: "function",
      startLine: 5,
      endLine: 5,
    },
    {
      filePath: "src/a.ts",
      symbolName: "alpha",
      kind: "function",
      startLine: 1,
      endLine: 1,
    },
  ]);
  setFileSymbolMap(REPO_ID, fileMap("src/z.ts", "zeta", 5));
  setFileSymbolMap(REPO_ID, fileMap("src/a.ts", "alpha", 1));
  createSession(session("session-z"));
  createSession(session("session-a"));
  createSession(session("session-other", OWNER, "other"));
}

beforeEach(() => {
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
  clearRepositoryFileSnapshots();
  clearRepositorySymbolIndex();
  clearGraphSourceStore();
  clearRepositoryIntelligenceHistory(REPO_ID);
  clearRepositoryIntelligenceHistory(`${OWNER}/other`);
  clearAllSessions();
});

describe("repository lifecycle manager", () => {
  it("delegates connect indexing and returns the resulting dashboard summary", async () => {
    let delegated = 0;

    const result = await connectRepository({
      owner: OWNER,
      repo: REPO,
      indexRepository: async () => {
        delegated += 1;
        setRepositoryIndexed(OWNER, REPO, COUNTS);
        return {
          owner: OWNER,
          repo: REPO,
          indexed: true,
        };
      },
    });

    expect(delegated).toBe(1);
    expect(result.repository).toEqual({
      owner: OWNER,
      repo: REPO,
      repoId: REPO_ID,
    });
    expect(result.indexResult).toEqual({
      owner: OWNER,
      repo: REPO,
      indexed: true,
    });
    expect(result.summary.repository).toBe(REPO_ID);
    expect(result.summary.metrics).toEqual({
      files: COUNTS.fileCount,
      chunks: COUNTS.chunkCount,
      symbols: COUNTS.symbolCount,
      graphNodes: COUNTS.graphNodeCount,
      graphEdges: COUNTS.graphEdgeCount,
    });
  });

  it("propagates connect indexing errors", async () => {
    const error = new Error("index failed");

    await expect(
      connectRepository({
        owner: OWNER,
        repo: REPO,
        indexRepository: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow(error);
  });

  it("returns the existing repository dashboard summary output", () => {
    seedRepository();

    const summary = getRepositorySummary({ owner: OWNER, repo: REPO });

    expect(summary.repository).toBe(REPO_ID);
    expect(summary.metrics).toEqual({
      files: COUNTS.fileCount,
      chunks: COUNTS.chunkCount,
      symbols: COUNTS.symbolCount,
      graphNodes: COUNTS.graphNodeCount,
      graphEdges: COUNTS.graphEdgeCount,
    });
    expect(summary.status.health).toMatchObject({
      repository: REPO_ID,
      indexed: true,
      healthy: true,
      stale: false,
      status: "indexed",
    });
    expect(summary.status.readiness).toMatchObject({
      repository: REPO_ID,
      ready: true,
      status: "indexed",
      indexedFiles: COUNTS.fileCount,
      indexedChunks: COUNTS.chunkCount,
    });
  });

  it("coordinates cleanup planner, executor, and report without changing output shape", () => {
    seedRepository();

    const report = cleanupRepository({ owner: OWNER, repo: REPO });

    expect(report).toEqual({
      repositoryId: REPO_ID,
      success: false,
      summary: {
        totalExecuted: 9,
        totalSkipped: 1,
      },
      executedResources: [
        "fileSnapshots:src/a.ts",
        "fileSnapshots:src/z.ts",
        "graphMetadata:src/a.ts",
        "graphMetadata:src/z.ts",
        "repositoryMetadata:acme/demo",
        "sessionReferences:session-a",
        "sessionReferences:session-z",
        "symbolRecords:src/a.ts:1:1:function:alpha",
        "symbolRecords:src/z.ts:5:5:function:zeta",
      ],
      skippedResources: ["cachedRetrievalArtifacts:unsupported"],
      warnings: [
        "Skipped unsupported cleanup resource: cachedRetrievalArtifacts:unsupported",
      ],
      statistics: {
        executionCoverage: 0.9,
        unsupportedResources: 1,
        completionPercentage: 90,
      },
    });

    expect(getRepositoryIndexMetadata(OWNER, REPO)).toBeNull();
    expect(getRepositoryFileSnapshot(REPO_ID)).toBeNull();
    expect(getRepositorySymbols(REPO_ID)).toEqual([]);
    expect(getFileSymbolMaps(REPO_ID)).toEqual([]);
    expect(getSessionById("session-a")).toBeNull();
    expect(getSessionById("session-z")).toBeNull();
    expect(getSessionById("session-other")).not.toBeNull();
  });

  it("is deterministic for an already cleaned repository", () => {
    setRepositoryOwner(REPO_ID, "user-a");

    const first = cleanupRepository({ owner: OWNER, repo: REPO });
    const second = cleanupRepository({ owner: OWNER, repo: REPO });

    expect(second).toEqual(first);
    expect(first).toEqual({
      repositoryId: REPO_ID,
      success: false,
      summary: {
        totalExecuted: 0,
        totalSkipped: 1,
      },
      executedResources: [],
      skippedResources: ["cachedRetrievalArtifacts:unsupported"],
      warnings: [
        "Skipped unsupported cleanup resource: cachedRetrievalArtifacts:unsupported",
      ],
      statistics: {
        executionCoverage: 0,
        unsupportedResources: 1,
        completionPercentage: 0,
      },
    });
  });
});
