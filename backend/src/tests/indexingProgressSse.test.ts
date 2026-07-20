import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, test } from "node:test";

import { createApp } from "../app.js";
import { MetricsRegistry } from "../observability/metrics.js";
import {
  IndexingProgressPublisher,
  type IndexingProgressEvent,
} from "../services/indexing/events/indexingProgressPublisher.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import {
  INDEXING_JOB_STAGE_PROGRESS,
  processNextIndexingJob,
} from "../services/indexing/jobs/indexingJobWorker.js";
import type { CreateIndexingJobInput } from "../services/indexing/jobs/indexingJobStore.js";
import {
  clearRepositoryOwners,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";

const USER_A = { userId: "sse-user-a", email: "sse-a@example.com" };
const USER_B = { userId: "sse-user-b", email: "sse-b@example.com" };
const TOKEN_A = `Bearer ${await signAccessToken(USER_A)}`;
const TOKEN_B = `Bearer ${await signAccessToken(USER_B)}`;
const JOB_INPUT: CreateIndexingJobInput = {
  repositoryId: "acme/sse-demo",
  ownerUserId: USER_A.userId,
  repositoryOwner: "acme",
  repositoryName: "sse-demo",
  repositoryUrl: "https://github.com/acme/sse-demo",
  branch: "main",
};

function testPublisher(
  store: MemoryIndexingJobStore,
  metrics = new MetricsRegistry(),
  entries: Array<{ event: string; fields?: Record<string, unknown> }> = [],
  heartbeatIntervalMs = 60_000,
) {
  return {
    metrics,
    entries,
    publisher: new IndexingProgressPublisher({
      jobStore: store,
      metrics,
      heartbeatIntervalMs,
      pollIntervalMs: 60_000,
      logger: {
        info: (event, fields) => entries.push({ event, fields }),
      },
    }),
  };
}

async function flushEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  clearRepositoryOwners();
  setRepositoryOwner(JOB_INPUT.repositoryId, USER_A.userId);
});

test("subscriber connects, receives queued replay, and disconnect cleanup removes listeners", async () => {
  const store = new MemoryIndexingJobStore();
  const job = await store.createJob(JOB_INPUT);
  const { publisher, metrics, entries } = testPublisher(store);
  const events: IndexingProgressEvent[] = [];

  const subscription = publisher.subscribe(job, (event) => { events.push(event); });
  await flushEvents();

  assert.equal(publisher.activeSubscriberCount(job.repositoryId), 1);
  assert.equal(events[0]?.event, "progress");
  assert.equal(events[0]?.data.stage, "queued");
  assert.equal(events[0]?.data.percentage, 0);
  assert.equal(events[0]?.data.jobId, job.jobId);
  assert.equal(events[0]?.data.repositoryId, job.repositoryId);
  assert.match(events[0]?.data.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.match(metrics.render(), /giro_indexing_sse_clients_active 1/);
  assert.equal(entries[0]?.event, "indexing_sse_subscriber_connected");

  subscription.unsubscribe();
  await subscription.closed;
  assert.equal(publisher.activeSubscriberCount(), 0);
  assert.match(metrics.render(), /giro_indexing_sse_clients_active 0/);
  assert.equal(entries.at(-1)?.event, "indexing_sse_subscriber_disconnected");
  assert.equal(entries.at(-1)?.fields?.reason, "disconnected");
});

test("reconnect immediately replays the latest durable stage", async () => {
  const store = new MemoryIndexingJobStore();
  const job = await store.createJob(JOB_INPUT);
  const { publisher } = testPublisher(store);
  const first = publisher.subscribe(job, () => undefined);
  await flushEvents();
  first.unsubscribe();
  await first.closed;

  await store.claimNextJob("worker-1");
  await store.markRunning(job.jobId, "embed");
  const latest = await store.updateProgress(job.jobId, 90, "embed");
  assert.ok(latest);
  const replayed: IndexingProgressEvent[] = [];
  const second = publisher.subscribe(latest, (event) => { replayed.push(event); });
  await flushEvents();

  assert.equal(replayed.length, 1);
  assert.equal(replayed[0]?.data.stage, "embedding");
  assert.equal(replayed[0]?.data.percentage, 65);
  second.unsubscribe();
  await second.closed;
});

test("multiple subscribers receive independent progress and completed streams", async () => {
  const store = new MemoryIndexingJobStore();
  const job = await store.createJob(JOB_INPUT);
  const { publisher, metrics } = testPublisher(store);
  const firstEvents: IndexingProgressEvent[] = [];
  const secondEvents: IndexingProgressEvent[] = [];
  const first = publisher.subscribe(job, (event) => { firstEvents.push(event); });
  const second = publisher.subscribe(job, (event) => { secondEvents.push(event); });
  await flushEvents();

  await store.claimNextJob("worker-1");
  const running = await store.markRunning(job.jobId, "clone");
  assert.ok(running);
  await publisher.publish(running);
  const succeeded = await store.markSucceeded(job.jobId);
  assert.ok(succeeded);
  await publisher.publish(succeeded);
  await Promise.all([first.closed, second.closed]);

  assert.deepEqual(firstEvents.map((event) => event.event), ["progress", "progress", "completed"]);
  assert.deepEqual(
    secondEvents.map((event) => [event.event, event.data.stage, event.data.percentage]),
    firstEvents.map((event) => [event.event, event.data.stage, event.data.percentage]),
  );
  assert.equal(publisher.activeSubscriberCount(), 0);
  assert.match(metrics.render(), /giro_indexing_progress_events_total 1/);
  assert.match(metrics.render(), /giro_indexing_sse_streams_total\{outcome="completed"\} 2/);
});

test("heartbeat is sent on the configured interval and stops after disconnect", async () => {
  const store = new MemoryIndexingJobStore();
  const job = await store.createJob(JOB_INPUT);
  const { publisher } = testPublisher(store, new MetricsRegistry(), [], 10);
  const events: IndexingProgressEvent[] = [];
  const subscription = publisher.subscribe(job, (event) => { events.push(event); });
  await delay(35);
  const beforeDisconnect = events.filter((event) => event.event === "heartbeat").length;
  assert.ok(beforeDisconnect >= 2);
  assert.equal(events.find((event) => event.event === "heartbeat")?.data.stage, "queued");

  subscription.unsubscribe();
  await subscription.closed;
  await delay(25);
  assert.equal(events.filter((event) => event.event === "heartbeat").length, beforeDisconnect);
});

test("worker lifecycle automatically publishes canonical progress and structured logs", async () => {
  const store = new MemoryIndexingJobStore();
  const job = await store.createJob(JOB_INPUT);
  const { publisher, entries } = testPublisher(store);
  const events: IndexingProgressEvent[] = [];
  const subscription = publisher.subscribe(job, (event) => { events.push(event); });
  await flushEvents();

  await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    progressPublisher: publisher,
    repositoryStore: {
      markIndexing: () => undefined,
      markIndexed: () => undefined,
      markFailed: () => undefined,
    },
    executeIndexingPipeline: async ({ reportStage }) => {
      for (const stage of INDEXING_JOB_STAGE_PROGRESS) await reportStage(stage);
      return {
        counts: {
          chunkCount: 1,
          fileCount: 1,
          symbolCount: 1,
          graphNodeCount: 1,
          graphEdgeCount: 0,
          summaryAvailable: true,
        },
      };
    },
  });
  await subscription.closed;

  const stages = events.map((event) => event.data.stage);
  assert.equal(stages[0], "queued");
  for (const stage of [
    "cloning",
    "parsing",
    "chunking",
    "embedding",
    "uploading_vectors",
    "finalizing",
    "completed",
  ] as const) {
    assert.ok(stages.includes(stage), `missing ${stage}`);
  }
  assert.equal(entries.some((entry) => entry.event === "indexing_progress_published"), true);
  assert.equal(entries.some((entry) => entry.event === "indexing_completed"), true);
});

test("failed worker event closes every stream and records failure metrics and logs", async () => {
  const store = new MemoryIndexingJobStore();
  const job = await store.createJob(JOB_INPUT);
  const { publisher, metrics, entries } = testPublisher(store);
  const received: IndexingProgressEvent[] = [];
  const subscription = publisher.subscribe(job, (event) => { received.push(event); });
  await flushEvents();

  await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    progressPublisher: publisher,
    repositoryStore: {
      markIndexing: () => undefined,
      markIndexed: () => undefined,
      markFailed: () => undefined,
    },
    executeIndexingPipeline: async () => {
      throw new Error("indexing failed");
    },
  });
  await subscription.closed;

  assert.equal(received.at(-1)?.event, "failed");
  assert.equal(received.at(-1)?.data.stage, "failed");
  assert.match(metrics.render(), /giro_indexing_sse_streams_total\{outcome="failed"\} 1/);
  assert.equal(entries.some((entry) => entry.event === "indexing_failed"), true);
});

test("SSE endpoint enforces authentication and repository ownership", async () => {
  const store = new MemoryIndexingJobStore();
  await store.createJob(JOB_INPUT);
  setRepositoryOwner(JOB_INPUT.repositoryId, USER_A.userId);
  const app = createApp({ indexingJobStore: store });
  const path = `/repositories/${encodeURIComponent(JOB_INPUT.repositoryId)}/indexing/events`;

  const unauthenticated = await app.request(path);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json() as { error?: { code?: string } }).error?.code, "unauthorized");

  const forbidden = await app.request(path, { headers: { authorization: TOKEN_B } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json() as { error?: { code?: string } }).error?.code, "repo_not_owned");
});

test("owner SSE connection has production headers, replays latest stage, and cleans up on abort", async () => {
  const store = new MemoryIndexingJobStore();
  const job = await store.createJob(JOB_INPUT);
  await store.claimNextJob("worker-1");
  await store.markRunning(job.jobId, "scan");
  const latest = await store.updateProgress(job.jobId, 25, "scan");
  assert.ok(latest);
  setRepositoryOwner(JOB_INPUT.repositoryId, USER_A.userId);
  const metrics = new MetricsRegistry();
  const { publisher } = testPublisher(store, metrics);
  const app = createApp({
    indexingJobStore: store,
    indexingProgressPublisher: publisher,
    metrics,
  });
  const controller = new AbortController();
  const response = await app.request(
    `/repositories/${encodeURIComponent(JOB_INPUT.repositoryId)}/indexing/events`,
    { headers: { authorization: TOKEN_A }, signal: controller.signal },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.equal(response.headers.get("connection"), "keep-alive");
  const reader = response.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  const frame = new TextDecoder().decode(first.value);
  assert.match(frame, /event: progress/);
  assert.match(frame, /"stage":"parsing"/);
  assert.match(frame, /"percentage":25/);
  assert.equal(publisher.activeSubscriberCount(), 1);

  controller.abort();
  await reader.cancel().catch(() => undefined);
  await flushEvents();
  assert.equal(publisher.activeSubscriberCount(), 0);
  assert.match(metrics.render(), /giro_indexing_sse_clients_active 0/);
});
