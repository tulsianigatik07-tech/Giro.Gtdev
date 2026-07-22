import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
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
  listIndexedRepositories,
  setRepositoryIndexed,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import {
  clearRepositoryOwners,
  getRepositoryOwner,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";
import type { RepositoryCleanupReport } from "../services/repository/repositoryCleanupReport.js";
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

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };
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

type ApiResponse<T = unknown> = {
  success?: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
};

type CallResult<T = unknown> = {
  status: number;
  body: ApiResponse<T>;
};

async function authHeader(user: typeof USER_A): Promise<string> {
  return `Bearer ${await signAccessToken(user)}`;
}

async function call<T>(
  method: string,
  path: string,
  token?: string,
): Promise<CallResult<T>> {
  const app = createApp();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = token;

  const res = await app.request(path, {
    method,
    headers,
  });
  const body = (await res.json().catch(() => ({}))) as ApiResponse<T>;

  return { status: res.status, body };
}

async function cleanup(token?: string): Promise<CallResult<RepositoryCleanupReport>> {
  return call<RepositoryCleanupReport>("DELETE", `/repos/${OWNER}/${REPO}`, token);
}

async function dashboard(token?: string): Promise<CallResult<Record<string, unknown>>> {
  return call<Record<string, unknown>>(
    "GET",
    `/repos/${OWNER}/${REPO}/dashboard`,
    token,
  );
}

function scanned(filePath: string, size = 10): ScannedFile {
  return {
    filePath,
    size,
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
    userId: USER_A.userId,
    owner,
    repo,
    title: `${owner}/${repo}`,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    messages: [],
    selectedContext: [],
  };
}

function seedRepositoryLifecycle(): void {
  setRepositoryIndexed(OWNER, REPO, COUNTS);
  setRepositoryOwner(REPO_ID, USER_A.userId);
  saveRepositoryFileSnapshot(REPO_ID, [
    scanned("src/z.ts", 20),
    scanned("src/a.ts", 10),
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

function expectEmptyCleanupReport(report: RepositoryCleanupReport): void {
  expect(report).toEqual({
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

describe("repository cleanup integration", () => {
  it("runs the complete repository cleanup lifecycle through the route", async () => {
    seedRepositoryLifecycle();

    expect(getRepositoryIndexMetadata(OWNER, REPO)).not.toBeNull();

    const token = await authHeader(USER_A);
    const beforeDashboard = await dashboard(token);

    expect(beforeDashboard.status).toBe(200);
    expect(beforeDashboard.body.success).toBe(true);
    expect(beforeDashboard.body.data?.repository).toBe(REPO_ID);
    expect(beforeDashboard.body.data?.metrics).toEqual({
      files: COUNTS.fileCount,
      chunks: COUNTS.chunkCount,
      symbols: COUNTS.symbolCount,
      graphNodes: COUNTS.graphNodeCount,
      graphEdges: COUNTS.graphEdgeCount,
    });

    const cleanupResult = await cleanup(token);

    expect(cleanupResult.status).toBe(200);
    expect(cleanupResult.body.success).toBe(true);

    const report = cleanupResult.body.data;
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

    expect(report?.executedResources).toEqual(
      [...(report?.executedResources ?? [])].sort((a, b) => a.localeCompare(b)),
    );
    expect(getRepositoryIndexMetadata(OWNER, REPO)).toBeNull();
    expect(listIndexedRepositories()).toEqual([]);
    expect(getRepositoryFileSnapshot(REPO_ID)).toBeNull();
    expect(getRepositorySymbols(REPO_ID)).toEqual([]);
    expect(getFileSymbolMaps(REPO_ID)).toEqual([]);
    expect(getSessionById("session-a")).toBeNull();
    expect(getSessionById("session-z")).toBeNull();
    expect(getSessionById("session-other")).not.toBeNull();
    expect(getRepositoryOwner(REPO_ID)).toBeUndefined();

    const afterDashboard = await dashboard(token);

    expect(afterDashboard.status).toBe(404);
    expect(afterDashboard.body.error?.code).toBe("repo_not_connected");
  });

  it("is deterministic when cleanup is called twice", async () => {
    seedRepositoryLifecycle();
    const token = await authHeader(USER_A);

    const first = await cleanup(token);
    const second = await cleanup(token);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.data?.executedResources).toEqual([
      "fileSnapshots:src/a.ts",
      "fileSnapshots:src/z.ts",
      "graphMetadata:src/a.ts",
      "graphMetadata:src/z.ts",
      "repositoryMetadata:acme/demo",
      "sessionReferences:session-a",
      "sessionReferences:session-z",
      "symbolRecords:src/a.ts:1:1:function:alpha",
      "symbolRecords:src/z.ts:5:5:function:zeta",
    ]);
    expect(second.body.data).toEqual(first.body.data);
    expect(getRepositoryIndexMetadata(OWNER, REPO)).toBeNull();
  });

  it("returns 404 for a missing repository with no ownership record", async () => {
    const token = await authHeader(USER_A);

    const result = await cleanup(token);

    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("repo_not_connected");
    expect(getRepositoryIndexMetadata(OWNER, REPO)).toBeNull();
  });

  it("blocks cleanup for a foreign repository without mutating metadata", async () => {
    seedRepositoryLifecycle();
    const metadataBefore = getRepositoryIndexMetadata(OWNER, REPO);
    const snapshotBefore = getRepositoryFileSnapshot(REPO_ID);
    const token = await authHeader(USER_B);

    const result = await cleanup(token);

    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("repo_not_owned");
    expect(getRepositoryIndexMetadata(OWNER, REPO)).toEqual(metadataBefore);
    expect(getRepositoryFileSnapshot(REPO_ID)).toEqual(snapshotBefore);
    expect(getRepositoryOwner(REPO_ID)).toBe(USER_A.userId);
  });

  it("deletes a connected repository without indexed artifacts", async () => {
    setRepositoryOwner(REPO_ID, USER_A.userId);
    const token = await authHeader(USER_A);

    const result = await cleanup(token);

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expectEmptyCleanupReport(result.body.data as RepositoryCleanupReport);

    const afterDashboard = await dashboard(token);

    expect(afterDashboard.status).toBe(404);
    expect(afterDashboard.body.error?.code).toBe("repo_not_connected");
  });
});
