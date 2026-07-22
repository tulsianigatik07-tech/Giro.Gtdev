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
  clearRepositorySymbolIndex,
  getRepositorySymbols,
  saveRepositorySymbols,
} from "../services/repository/symbolIndexStore.js";
import type { FileSymbolMap } from "../services/graph/types.js";
import type { ScannedFile } from "../services/repository/scanner.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };
const REPO_ID = "acme/demo";

const COUNTS: IndexedCounts = {
  chunkCount: 1,
  fileCount: 1,
  symbolCount: 1,
  graphNodeCount: 1,
  graphEdgeCount: 0,
  summaryAvailable: true,
};

type ApiResponse = {
  success?: boolean;
  data?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
};

async function authHeader(user: typeof USER_A): Promise<string> {
  return `Bearer ${await signAccessToken(user)}`;
}

async function requestCleanup(
  token?: string,
): Promise<{ status: number; body: ApiResponse }> {
  const app = createApp();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = token;

  const res = await app.request("/repos/acme/demo", {
    method: "DELETE",
    headers,
  });
  const body = (await res.json().catch(() => ({}))) as ApiResponse;

  return { status: res.status, body };
}

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
        name: "alpha",
        kind: "function",
        exported: true,
        line: 1,
      },
    ],
    imports: [],
  };
}

function seedRepository(): void {
  setRepositoryOwner(REPO_ID, USER_A.userId);
  setRepositoryIndexed("acme", "demo", COUNTS);
  saveRepositoryFileSnapshot(REPO_ID, [scanned("src/a.ts")]);
  saveRepositorySymbols(REPO_ID, [
    {
      filePath: "src/a.ts",
      symbolName: "alpha",
      kind: "function",
      startLine: 1,
      endLine: 1,
    },
  ]);
  setFileSymbolMap(REPO_ID, fileMap("src/a.ts"));
}

beforeEach(() => {
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
  clearRepositoryFileSnapshots();
  clearRepositorySymbolIndex();
  clearGraphSourceStore();
});

describe("repository cleanup route", () => {
  it("returns 401 without auth", async () => {
    const result = await requestCleanup();

    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("unauthorized");
  });

  it("returns 404 when repo is not connected or owned", async () => {
    const token = await authHeader(USER_A);
    const result = await requestCleanup(token);

    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("repo_not_connected");
  });

  it("returns 403 when repo belongs to another user", async () => {
    setRepositoryOwner(REPO_ID, USER_A.userId);

    const token = await authHeader(USER_B);
    const result = await requestCleanup(token);

    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("repo_not_owned");
  });

  it("cleans repository metadata for the owner and returns cleanup report", async () => {
    seedRepository();

    const token = await authHeader(USER_A);
    const result = await requestCleanup(token);

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);

    const report = result.body.data as RepositoryCleanupReport;
    expect(report.repositoryId).toBe(REPO_ID);
    expect(report.executedResources).toEqual([
      "fileSnapshots:src/a.ts",
      "graphMetadata:src/a.ts",
      "repositoryMetadata:acme/demo",
      "symbolRecords:src/a.ts:1:1:function:alpha",
    ]);
    expect(report.skippedResources).toEqual([
      "cachedRetrievalArtifacts:unsupported",
    ]);
    expect(report.summary).toEqual({
      totalExecuted: 4,
      totalSkipped: 1,
    });

    expect(getRepositoryIndexMetadata("acme", "demo")).toBeNull();
    expect(getRepositoryFileSnapshot(REPO_ID)).toBeNull();
    expect(getRepositorySymbols(REPO_ID)).toEqual([]);
    expect(getFileSymbolMaps(REPO_ID)).toEqual([]);
    expect(getRepositoryOwner(REPO_ID)).toBeUndefined();
  });
});
