import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { signAccessToken } from "../services/auth/jwt.js";
import {
  clearRepositoryIndexRegistry,
  setRepositoryIndexed,
  type IndexedCounts,
} from "../services/repository/indexingService.js";
import {
  clearRepositoryOwners,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";
import {
  clearRepositoryLifecycleEvents,
  recordRepositoryLifecycleEvent,
} from "../services/repository/repositoryLifecycleEvents.js";

const USER_A = { userId: "user-a", email: "a@example.com" };
const USER_B = { userId: "user-b", email: "b@example.com" };
const REPO_ID = "acme/demo";

const INDEX_COUNTS: IndexedCounts = {
  chunkCount: 11,
  fileCount: 7,
  symbolCount: 19,
  graphNodeCount: 23,
  graphEdgeCount: 29,
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

async function requestDashboardIntelligence(
  token?: string,
): Promise<{ status: number; body: ApiResponse }> {
  const app = createApp();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = token;

  const res = await app.request("/repos/acme/demo/dashboard/intelligence", {
    method: "GET",
    headers,
  });
  const body = (await res.json().catch(() => ({}))) as ApiResponse;

  return { status: res.status, body };
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  return value as Record<string, unknown>;
}

function seedOwnedRepository(): void {
  setRepositoryOwner(REPO_ID, USER_A.userId);
  setRepositoryIndexed("acme", "demo", INDEX_COUNTS);
}

beforeEach(() => {
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
  clearRepositoryLifecycleEvents();
});

describe("repository dashboard intelligence route", () => {
  it("1. unauthenticated request returns 401", async () => {
    const result = await requestDashboardIntelligence();

    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("unauthorized");
  });

  it("2. missing ownership/repo follows existing missing repo behavior", async () => {
    const token = await authHeader(USER_A);
    const result = await requestDashboardIntelligence(token);

    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("repo_not_connected");
  });

  it("3. foreign owner returns 403", async () => {
    setRepositoryOwner(REPO_ID, USER_A.userId);

    const token = await authHeader(USER_B);
    const result = await requestDashboardIntelligence(token);

    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("repo_not_owned");
  });

  it("4. owner receives 200 with dashboard intelligence bundle", async () => {
    seedOwnedRepository();

    const token = await authHeader(USER_A);
    const result = await requestDashboardIntelligence(token);

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);

    const data = asRecord(result.body.data);
    expect(data.repositoryId).toBe(REPO_ID);
    expect(data.retrievalExplainability).toBeUndefined();

    const dashboard = asRecord(data.dashboard);
    expect(dashboard.repository).toBe(REPO_ID);
    expect(asRecord(dashboard.metrics).files).toBe(INDEX_COUNTS.fileCount);

    const health = asRecord(data.health);
    expect(health.repositoryId).toBe(REPO_ID);
    expect(health.healthy).toBe(true);

    const aiReadiness = asRecord(data.aiReadiness);
    expect(aiReadiness.repositoryId).toBe(REPO_ID);
    expect(aiReadiness.ready).toBe(true);

    const insights = asRecord(data.insights);
    expect(insights.repositoryId).toBe(REPO_ID);
    expect(Array.isArray(insights.insights)).toBe(true);

    expect(Array.isArray(data.timeline)).toBe(true);
  });

  it("5. lifecycle events appear in timeline when present", async () => {
    seedOwnedRepository();
    recordRepositoryLifecycleEvent({
      repositoryId: REPO_ID,
      type: "repository_dashboard_viewed",
      message: "Repository dashboard summary viewed.",
      metadata: {
        files: INDEX_COUNTS.fileCount,
        chunks: INDEX_COUNTS.chunkCount,
      },
    });

    const token = await authHeader(USER_A);
    const result = await requestDashboardIntelligence(token);

    expect(result.status).toBe(200);
    const data = asRecord(result.body.data);
    const timeline = data.timeline as unknown[];
    expect(timeline).toHaveLength(1);
    expect(asRecord(timeline[0]).type).toBe("repository_dashboard_viewed");
  });

  it("6. retrievalExplainability is absent because route has no query-specific retrieval", async () => {
    seedOwnedRepository();

    const token = await authHeader(USER_A);
    const result = await requestDashboardIntelligence(token);

    expect(result.status).toBe(200);
    const data = asRecord(result.body.data);
    expect(Object.prototype.hasOwnProperty.call(data, "retrievalExplainability")).toBe(false);
  });
});
