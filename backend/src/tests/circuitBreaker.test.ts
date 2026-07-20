import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI, { APIConnectionError, APIError } from "openai";
import { createCircuitBreaker, DependencyUnavailableError } from "../runtime/circuitBreaker.js";
import { DeadlineExceededError, createDeadline } from "../runtime/deadline.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { isTransientAiError, streamCompletion } from "../services/ai/provider.js";
import { isTransientEmbeddingError, requestOpenAIEmbedding } from "../services/embeddings/embedder.js";
import { isTransientDatabaseError, retryDatabaseRead } from "../services/database/retryPolicy.js";
import { cloneRepo, isTransientCloneError, repoClonePath } from "../services/repository/clone.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { processNextIndexingJob } from "../services/indexing/jobs/indexingJobWorker.js";
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { createRequestContextMiddleware } from "../middleware/requestContext.js";
import { onError } from "../middleware/errorHandler.js";
import { setRepositoryOwner } from "../services/repository/ownershipStore.js";

function fixture(overrides: Partial<Parameters<typeof createCircuitBreaker>[0]> = {}) {
  let now = 0;
  const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const metrics = new MetricsRegistry();
  const breaker = createCircuitBreaker({
    name: "ai",
    minimumSamples: 3,
    failureThreshold: 2,
    rollingWindowMs: 1_000,
    openDurationMs: 100,
    halfOpenMaxCalls: 1,
    shouldCountFailure: () => true,
    clock: () => now,
    logger: { info: (event, fields) => events.push({ event, fields }) },
    metrics,
    ...overrides,
  });
  return { breaker, events, metrics, advance: (ms: number) => { now += ms; } };
}

test("starts closed and successful calls remain closed", async () => {
  const { breaker } = fixture();
  assert.equal(breaker.getState(), "closed");
  assert.equal(await breaker.execute(async () => "ok"), "ok");
  assert.deepEqual(breaker.getSnapshot(), {
    state: "closed",
    sampleCount: 1,
    failureCount: 0,
    openedAt: null,
    nextProbeAt: null,
    activeHalfOpenCalls: 0,
  });
});

test("permanent and caller-cancelled failures do not enter the sample window", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const { breaker } = fixture({ shouldCountFailure: () => false });
  await assert.rejects(breaker.execute(async () => { throw new Error("bad request"); }));
  await assert.rejects(breaker.execute(async () => { throw new Error("cancelled"); }, { signal: controller.signal }));
  assert.equal(breaker.getSnapshot().sampleCount, 0);
});

test("minimum samples and failure threshold are both required to open", async () => {
  const { breaker } = fixture();
  await assert.rejects(breaker.execute(async () => { throw new Error("one"); }));
  await assert.rejects(breaker.execute(async () => { throw new Error("two"); }));
  assert.equal(breaker.getState(), "closed");
  await breaker.execute(async () => "success");
  assert.equal(breaker.getState(), "open");
});

test("open circuit rejects immediately without executing upstream", async () => {
  let calls = 0;
  const { breaker } = fixture({ minimumSamples: 1, failureThreshold: 1 });
  await assert.rejects(breaker.execute(async () => { throw new Error("failure"); }));
  await assert.rejects(
    breaker.execute(async () => { calls += 1; }),
    DependencyUnavailableError,
  );
  assert.equal(calls, 0);
});

test("cooldown enters half-open, limits probes, and successful probe closes", async () => {
  const state = fixture({ minimumSamples: 1, failureThreshold: 1 });
  await assert.rejects(state.breaker.execute(async () => { throw new Error("failure"); }));
  state.advance(100);
  let release!: () => void;
  const probe = state.breaker.execute(() => new Promise<void>((resolve) => { release = resolve; }));
  await Promise.resolve();
  assert.equal(state.breaker.getState(), "half_open");
  assert.equal(state.breaker.getSnapshot().activeHalfOpenCalls, 1);
  await assert.rejects(state.breaker.execute(async () => undefined), DependencyUnavailableError);
  release();
  await probe;
  assert.equal(state.breaker.getState(), "closed");
});

test("failed qualifying probe reopens with a new cooldown", async () => {
  const state = fixture({ minimumSamples: 1, failureThreshold: 1 });
  await assert.rejects(state.breaker.execute(async () => { throw new Error("failure"); }));
  state.advance(100);
  await assert.rejects(state.breaker.execute(async () => { throw new Error("probe failure"); }));
  assert.equal(state.breaker.getState(), "open");
  assert.equal(state.breaker.getSnapshot().openedAt, 100);
  assert.equal(state.breaker.getSnapshot().nextProbeAt, 200);
});

test("racing half-open probes remain open when any qualifying probe fails", async () => {
  const state = fixture({ minimumSamples: 1, failureThreshold: 1, halfOpenMaxCalls: 2 });
  await assert.rejects(state.breaker.execute(async () => { throw new Error("failure"); }));
  state.advance(100);
  let resolveSuccess!: () => void;
  let rejectFailure!: (error: Error) => void;
  const success = state.breaker.execute(() => new Promise<void>((resolve) => { resolveSuccess = resolve; }));
  const failure = state.breaker.execute(() => new Promise<void>((_, reject) => { rejectFailure = reject; }));
  resolveSuccess();
  await success;
  assert.equal(state.breaker.getState(), "half_open");
  rejectFailure(new Error("probe failure"));
  await assert.rejects(failure);
  assert.equal(state.breaker.getState(), "open");
  assert.equal(state.breaker.getSnapshot().activeHalfOpenCalls, 0);
});

test("rolling window removes stale samples", async () => {
  const state = fixture({ minimumSamples: 2, failureThreshold: 2 });
  await assert.rejects(state.breaker.execute(async () => { throw new Error("old"); }));
  state.advance(1_001);
  await assert.rejects(state.breaker.execute(async () => { throw new Error("new"); }));
  assert.equal(state.breaker.getState(), "closed");
  assert.deepEqual(state.breaker.getSnapshot(), {
    state: "closed",
    sampleCount: 1,
    failureCount: 1,
    openedAt: null,
    nextProbeAt: null,
    activeHalfOpenCalls: 0,
  });
});

test("concurrent threshold crossing emits one open transition", async () => {
  const state = fixture({ minimumSamples: 2, failureThreshold: 2 });
  let rejectFirst!: (error: Error) => void;
  let rejectSecond!: (error: Error) => void;
  const first = state.breaker.execute(() => new Promise((_, reject) => { rejectFirst = reject; }));
  const second = state.breaker.execute(() => new Promise((_, reject) => { rejectSecond = reject; }));
  rejectFirst(new Error("one"));
  rejectSecond(new Error("two"));
  await Promise.allSettled([first, second]);
  assert.equal(state.breaker.getState(), "open");
  assert.equal(state.events.filter((entry) => entry.event === "circuit_opened").length, 1);
});

test("deadline expiry does not count as a dependency failure", async () => {
  const { breaker } = fixture({ shouldCountFailure: (error) => !(error instanceof DeadlineExceededError) });
  await assert.rejects(breaker.execute(async () => { throw new DeadlineExceededError(); }));
  assert.equal(breaker.getSnapshot().sampleCount, 0);
});

test("logs contain safe bounded fields and metrics maintain one active state", async () => {
  const state = fixture({ minimumSamples: 1, failureThreshold: 1 });
  await assert.rejects(state.breaker.execute(
    async () => { throw new Error("secret prompt and URL"); },
    { requestId: "request-1", repositoryId: "repo-1" },
  ));
  await assert.rejects(state.breaker.execute(async () => undefined), DependencyUnavailableError);
  const serialized = JSON.stringify(state.events);
  assert.equal(serialized.includes("secret prompt"), false);
  assert.deepEqual(
    Object.keys(state.events.find((entry) => entry.event === "circuit_opened")?.fields ?? {}).sort(),
    ["cooldownMs", "dependency", "failureCount", "nextState", "previousState", "repositoryId", "requestId", "sampleCount"],
  );
  const output = state.metrics.render();
  assert.match(output, /giro_circuit_state\{dependency="ai",state="open"\} 1/);
  assert.match(output, /giro_circuit_state\{dependency="ai",state="closed"\} 0/);
  assert.match(output, /giro_circuit_transitions_total\{dependency="ai",from="closed",to="open"\} 1/);
  assert.match(output, /giro_circuit_rejections_total\{dependency="ai"\} 1/);
});

const immediateRetry = {
  random: () => 0.5,
  setTimer: (callback: () => void) => { callback(); return 1; },
  clearTimer: () => undefined,
};

test("AI breaker observes retry exhaustion once and rejects the next stream creation", async () => {
  let upstreamCalls = 0;
  const breaker = fixture({ minimumSamples: 1, failureThreshold: 1, shouldCountFailure: isTransientAiError }).breaker;
  const client = { chat: { completions: { create: async () => {
    upstreamCalls += 1;
    throw new APIConnectionError({ message: "reset" });
  } } } } as unknown as OpenAI;
  await assert.rejects(streamCompletion([], {
    client,
    circuitBreaker: breaker,
    retryRuntime: immediateRetry,
    logger: { info: () => undefined },
    metrics: new MetricsRegistry(),
  }));
  assert.equal(upstreamCalls, 3);
  assert.equal(breaker.getSnapshot().failureCount, 1);
  await assert.rejects(streamCompletion([], {
    client,
    circuitBreaker: breaker,
    retryRuntime: immediateRetry,
  }), DependencyUnavailableError);
  assert.equal(upstreamCalls, 3);
});

test("successful AI retry counts as one breaker success", async () => {
  let calls = 0;
  const breaker = fixture({ shouldCountFailure: isTransientAiError }).breaker;
  const stream = { async *[Symbol.asyncIterator]() { yield { choices: [] }; } };
  const client = { chat: { completions: { create: async () => {
    calls += 1;
    if (calls === 1) throw new APIConnectionError({ message: "reset" });
    return stream;
  } } } } as unknown as OpenAI;
  const output = await streamCompletion([], {
    client,
    circuitBreaker: breaker,
    retryRuntime: immediateRetry,
    logger: { info: () => undefined },
    metrics: new MetricsRegistry(),
  });
  for await (const _chunk of output) {
    // Consume the fake stream so its provider deadline is disposed.
  }
  assert.equal(calls, 2);
  assert.deepEqual(breaker.getSnapshot(), {
    state: "closed", sampleCount: 1, failureCount: 0, openedAt: null, nextProbeAt: null, activeHalfOpenCalls: 0,
  });
});

test("embedding breaker wraps provider generation only", async () => {
  const breaker = fixture({ name: "embedding", minimumSamples: 1, failureThreshold: 1, shouldCountFailure: isTransientEmbeddingError }).breaker;
  let calls = 0;
  const client = { embeddings: { create: async () => {
    calls += 1;
    throw new APIConnectionError({ message: "network" });
  } } } as unknown as OpenAI;
  await assert.rejects(requestOpenAIEmbedding("input", {
    client, circuitBreaker: breaker, retryRuntime: immediateRetry,
    logger: { info: () => undefined }, metrics: new MetricsRegistry(),
  }));
  assert.equal(calls, 3);
  assert.equal(breaker.getState(), "open");
});

test("database breaker wraps retry-safe reads and not each retry attempt", async () => {
  const breaker = fixture({ name: "database", minimumSamples: 1, failureThreshold: 1, shouldCountFailure: isTransientDatabaseError }).breaker;
  const deadline = createDeadline(10_000);
  let calls = 0;
  await assert.rejects(retryDatabaseRead(async () => {
    calls += 1;
    return { data: null, error: { code: "PGRST000" } };
  }, {
    deadline, operation: "semantic_search", circuitBreaker: breaker,
    retryRuntime: immediateRetry, logger: { info: () => undefined }, metrics: new MetricsRegistry(),
  }));
  deadline.dispose();
  assert.equal(calls, 3);
  assert.equal(breaker.getSnapshot().failureCount, 1);
});

test("clone breaker rejects before filesystem or network work", async () => {
  const breaker = fixture({ name: "clone", minimumSamples: 1, failureThreshold: 1, shouldCountFailure: isTransientCloneError }).breaker;
  await assert.rejects(breaker.execute(async () => { throw new Error("connection reset"); }));
  const owner = "circuit-open-owner";
  const repo = "circuit-open-repo";
  let calls = 0;
  await assert.rejects(cloneRepo(owner, repo, {
    circuitBreaker: breaker,
    executeClone: async () => { calls += 1; },
  }), DependencyUnavailableError);
  assert.equal(calls, 0);
  assert.equal(existsSync(repoClonePath(owner, repo)), false);
});

test("worker records one retryable failure for breaker rejection", async () => {
  const store = new MemoryIndexingJobStore();
  const job = await store.createJob({
    repositoryId: "acme/circuit", ownerUserId: "user-1", repositoryOwner: "acme",
    repositoryName: "circuit", repositoryUrl: "https://github.com/acme/circuit", branch: "main",
  });
  setRepositoryOwner("acme/circuit", "user-1");
  const report = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    repositoryStore: { markIndexing: () => undefined, markIndexed: () => undefined, markFailed: () => undefined },
    executeIndexingPipeline: async () => { throw new DependencyUnavailableError(); },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.failure?.retryable, true);
  assert.equal((await store.getJob(job.jobId))?.status, "failed");
  assert.equal((await store.getJob(job.jobId))?.attempt, 1);
});

test("permanent provider errors do not affect provider circuit", async () => {
  const breaker = fixture({ minimumSamples: 1, failureThreshold: 1, shouldCountFailure: isTransientAiError }).breaker;
  await assert.rejects(breaker.execute(async () => {
    throw APIError.generate(401, {}, "unauthorized", new Headers());
  }));
  assert.equal(breaker.getSnapshot().sampleCount, 0);
  assert.equal(breaker.getState(), "closed");
});

test("breaker rejection uses safe standardized 503 response with request ID", async () => {
  const app = new Hono();
  app.use("*", createRequestContextMiddleware({
    generateRequestId: () => "circuit-request-id",
    logger: { info: () => undefined, error: () => undefined },
  }));
  app.get("/dependency", () => { throw new DependencyUnavailableError(); });
  app.onError(onError);
  const response = await app.request("/dependency");
  const body = await response.json() as {
    error: { code: string; message: string; retryable: boolean };
    requestId: string;
  };
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("X-Request-ID"), "circuit-request-id");
  assert.equal(body.requestId, "circuit-request-id");
  assert.equal(body.error.code, "dependency_unavailable");
  assert.equal(body.error.message, "A required service is temporarily unavailable.");
  assert.equal(body.error.retryable, true);
});
