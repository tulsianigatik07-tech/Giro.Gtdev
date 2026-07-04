import { beforeEach, describe, expect, it } from "vitest";

import { clearGraphSourceStore, setFileSymbolMap } from "../services/repository/graphSourceStore.js";
import {
  clearRepositoryFileSnapshots,
  getRepositoryFileSnapshot,
  saveRepositoryFileSnapshot,
} from "../services/repository/fileSnapshotStore.js";
import {
  clearRepositoryIndexRegistry,
  getRepositoryIndexMetadata,
  setRepositoryIndexed,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import {
  buildRepositoryCleanupPlan,
} from "../services/repository/repositoryCleanupPlanner.js";
import {
  clearRepositoryIntelligenceHistory,
  saveRepositoryIntelligence,
} from "../services/repository/repositoryIntelligenceHistory.js";
import type { RepositoryIntelligenceResult } from "../services/repository/repositoryIntelligenceService.js";
import {
  clearRepositorySymbolIndex,
  getRepositorySymbols,
  saveRepositorySymbols,
} from "../services/repository/symbolIndexStore.js";
import { clearAllSessions, createSession } from "../services/sessions/store.js";
import type { Session } from "../services/sessions/types.js";
import type { FileSymbolMap } from "../services/graph/types.js";
import type { ScannedFile } from "../services/repository/scanner.js";

const REPO_ID = "acme/demo";
const COUNTS: IndexedCounts = {
  chunkCount: 5,
  fileCount: 2,
  symbolCount: 3,
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

function fileMap(filePath: string): FileSymbolMap {
  return {
    filePath,
    language: "typescript",
    symbols: [
      {
        name: filePath.endsWith("a.ts") ? "alpha" : "beta",
        kind: "function",
        exported: true,
        line: filePath.endsWith("a.ts") ? 1 : 2,
      },
    ],
    imports: [],
  };
}

function session(id: string, owner = "acme", repo = "demo"): Session {
  return {
    id,
    userId: "user-a",
    owner,
    repo,
    title: `${owner}/${repo}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    selectedContext: [],
  };
}

function intelligence(repositoryId: string): RepositoryIntelligenceResult {
  return {
    repositoryId,
    repositoryName: repositoryId.split("/")[1] ?? repositoryId,
  } as RepositoryIntelligenceResult;
}

function seedIndexedRepository(): void {
  setRepositoryIndexed("acme", "demo", COUNTS);
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
  setFileSymbolMap(REPO_ID, fileMap("src/z.ts"));
  setFileSymbolMap(REPO_ID, fileMap("src/a.ts"));
  saveRepositoryIntelligence(intelligence(REPO_ID));
  createSession(session("session-z"));
  createSession(session("session-a"));
  createSession(session("session-other", "acme", "other"));
}

beforeEach(() => {
  clearRepositoryIndexRegistry();
  clearRepositoryFileSnapshots();
  clearRepositorySymbolIndex();
  clearGraphSourceStore();
  clearRepositoryIntelligenceHistory(REPO_ID);
  clearRepositoryIntelligenceHistory("acme/other");
  clearAllSessions();
});

describe("repository cleanup planner", () => {
  it("builds an empty repository cleanup plan", () => {
    const plan = buildRepositoryCleanupPlan("acme", "demo");

    expect(plan).toEqual({
      repository: {
        owner: "acme",
        repo: "demo",
        repoId: REPO_ID,
      },
      cleanupRequired: false,
      totalResources: 0,
      sections: {
        repositoryMetadata: {
          exists: false,
          metadata: null,
          reason: "no repository metadata found",
        },
        fileSnapshots: {
          exists: false,
          count: 0,
          identifiers: [],
          reason: "no repository file snapshot found",
        },
        symbolRecords: {
          exists: false,
          count: 0,
          identifiers: [],
          reason: "no repository symbol records found",
        },
        graphMetadata: {
          exists: false,
          count: 0,
          identifiers: [],
          reason: "no repository graph source metadata found",
        },
        repositoryIntelligenceHistory: {
          exists: false,
          count: 0,
          identifiers: [],
          reason: "no repository intelligence history found",
        },
        cachedRetrievalArtifacts: {
          exists: false,
          count: 0,
          identifiers: [],
          supported: false,
          reason: "no repository-scoped retrieval artifact store is registered",
        },
        sessionReferences: {
          exists: false,
          count: 0,
          identifiers: [],
          reason: "no repository session references found",
        },
      },
    });
  });

  it("builds an indexed repository cleanup plan", () => {
    seedIndexedRepository();

    const plan = buildRepositoryCleanupPlan("acme", "demo");

    expect(plan.cleanupRequired).toBe(true);
    expect(plan.totalResources).toBe(10);
    expect(plan.sections.repositoryMetadata.exists).toBe(true);
    expect(plan.sections.repositoryMetadata.metadata?.status).toBe("indexed");
    expect(plan.sections.repositoryMetadata.metadata?.fileCount).toBe(2);
    expect(plan.sections.fileSnapshots.count).toBe(2);
    expect(plan.sections.symbolRecords.count).toBe(2);
    expect(plan.sections.graphMetadata.count).toBe(2);
    expect(plan.sections.repositoryIntelligenceHistory.count).toBe(1);
    expect(plan.sections.cachedRetrievalArtifacts.count).toBe(0);
    expect(plan.sections.sessionReferences.identifiers).toEqual([
      "session-a",
      "session-z",
    ]);
  });

  it("sorts cleanup identifiers deterministically", () => {
    seedIndexedRepository();

    const plan = buildRepositoryCleanupPlan("acme", "demo");

    expect(plan.sections.fileSnapshots.identifiers).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(plan.sections.graphMetadata.identifiers).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(plan.sections.symbolRecords.identifiers).toEqual([
      "src/a.ts:1:1:function:alpha",
      "src/z.ts:5:5:function:zeta",
    ]);
    expect(plan.sections.sessionReferences.identifiers).toEqual([
      "session-a",
      "session-z",
    ]);
  });

  it("returns stable snapshots without mutating stores", () => {
    seedIndexedRepository();
    const metadataBefore = getRepositoryIndexMetadata("acme", "demo");
    const snapshotBefore = getRepositoryFileSnapshot(REPO_ID);
    const symbolsBefore = getRepositorySymbols(REPO_ID);

    const first = buildRepositoryCleanupPlan("acme", "demo");
    first.sections.fileSnapshots.identifiers.push("mutated.ts");
    if (first.sections.repositoryMetadata.metadata) {
      first.sections.repositoryMetadata.metadata.status = "failed";
    }

    const second = buildRepositoryCleanupPlan("acme", "demo");

    expect(second.sections.fileSnapshots.identifiers).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(second.sections.repositoryMetadata.metadata?.status).toBe("indexed");
    expect(getRepositoryIndexMetadata("acme", "demo")).toEqual(metadataBefore);
    expect(getRepositoryFileSnapshot(REPO_ID)).toEqual(snapshotBefore);
    expect(getRepositorySymbols(REPO_ID)).toEqual(symbolsBefore);
  });
});
