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

async function requestWorkspace(
  token?: string,
): Promise<{ status: number; body: ApiResponse }> {
  const app = createApp();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = token;

  const res = await app.request("/repos/acme/demo/workspace", {
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

function asArray(value: unknown): unknown[] {
  expect(Array.isArray(value)).toBe(true);
  return value as unknown[];
}

function seedOwnedRepository(): void {
  setRepositoryOwner(REPO_ID, USER_A.userId);
  setRepositoryIndexed("acme", "demo", INDEX_COUNTS);
}

function seedLifecycleEvents(count = 6): void {
  const eventTypes = [
    "repository_connected",
    "repository_indexed",
    "repository_dashboard_viewed",
    "repository_cleanup_planned",
    "repository_cleanup_executed",
    "repository_cleanup_reported",
  ] as const;

  for (const type of eventTypes.slice(0, count)) {
    recordRepositoryLifecycleEvent({
      repositoryId: REPO_ID,
      type,
      message: `${type} event`,
      metadata: { repository: REPO_ID },
    });
  }
}

beforeEach(() => {
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
  clearRepositoryLifecycleEvents();
});

describe("repository workspace route", () => {
  it("returns 401 without auth", async () => {
    const result = await requestWorkspace();

    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe("unauthorized");
  });

  it("returns 404 when repository ownership is missing", async () => {
    const token = await authHeader(USER_A);
    const result = await requestWorkspace(token);

    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("repo_not_connected");
  });

  it("returns 403 when repository belongs to another user", async () => {
    setRepositoryOwner(REPO_ID, USER_A.userId);

    const token = await authHeader(USER_B);
    const result = await requestWorkspace(token);

    expect(result.status).toBe(403);
    expect(result.body.error?.code).toBe("repo_not_owned");
  });

  it("returns 404 when repository is owned but not indexed", async () => {
    setRepositoryOwner(REPO_ID, USER_A.userId);

    const token = await authHeader(USER_A);
    const result = await requestWorkspace(token);

    expect(result.status).toBe(404);
    expect(result.body.error?.code).toBe("repo_not_connected");
  });

  it("returns a complete workspace payload for the repository owner", async () => {
    seedOwnedRepository();
    seedLifecycleEvents();

    const token = await authHeader(USER_A);
    const result = await requestWorkspace(token);

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);

    const data = asRecord(result.body.data);
    expect(data.repositoryId).toBe(REPO_ID);

    const dashboard = asRecord(data.dashboard);
    const health = asRecord(data.health);
    const aiReadiness = asRecord(data.aiReadiness);
    const insights = asRecord(data.insights);
    const recommendations = asRecord(data.recommendations);
    const timeline = asArray(data.timeline);
    const intelligenceReport = asRecord(data.intelligenceReport);
    const presentation = asRecord(data.presentation);

    expect(dashboard.repository).toBe(REPO_ID);
    expect(health.repositoryId).toBe(REPO_ID);
    expect(aiReadiness.repositoryId).toBe(REPO_ID);
    expect(insights.repositoryId).toBe(REPO_ID);
    expect(recommendations.repositoryId).toBe(REPO_ID);
    expect(intelligenceReport.repositoryId).toBe(REPO_ID);

    expect(timeline).toHaveLength(6);

    const reportSummary = asRecord(intelligenceReport.summary);
    const reportOverview = asRecord(intelligenceReport.overview);
    const heroCard = asRecord(presentation.heroCard);

    expect(heroCard.title).toBe(reportSummary.headline);
    expect(heroCard.status).toBe(reportSummary.status);
    expect(heroCard.score).toBe(reportOverview.score);
  });

  it("matches timeline preview to presenter behavior", async () => {
    seedOwnedRepository();
    seedLifecycleEvents();

    const token = await authHeader(USER_A);
    const result = await requestWorkspace(token);

    expect(result.status).toBe(200);
    const data = asRecord(result.body.data);
    const timeline = asArray(data.timeline).map(asRecord);
    const presentation = asRecord(data.presentation);
    const timelinePreview = asArray(presentation.timelinePreview).map(asRecord);

    expect(timelinePreview).toHaveLength(5);
    expect(timelinePreview.map((item) => item.sequence)).toEqual(
      timeline.slice(0, 5).map((item) => item.sequence),
    );
  });

  it("returns deterministic repeated workspace output", async () => {
    seedOwnedRepository();
    seedLifecycleEvents();

    const token = await authHeader(USER_A);
    const first = await requestWorkspace(token);
    const second = await requestWorkspace(token);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
  });
});
