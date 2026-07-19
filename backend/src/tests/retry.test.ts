import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI, { APIConnectionError, APIError } from "openai";
import { createDeadline, DeadlineExceededError } from "../runtime/deadline.js";
import { retry, retryDelayMs } from "../runtime/retry.js";
import { createRetryObservability } from "../observability/retryObservability.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { streamCompletion } from "../services/ai/provider.js";
import { isTransientEmbeddingError, requestOpenAIEmbedding } from "../services/embeddings/embedder.js";
import { isTransientDatabaseError, retryDatabaseRead } from "../services/database/retryPolicy.js";
import { cloneRepo, isTransientCloneError } from "../services/repository/clone.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { processNextIndexingJob } from "../services/indexing/jobs/indexingJobWorker.js";

const immediateTimers = {
  setTimer: (callback: () => void) => { callback(); return 1; },
  clearTimer: () => undefined,
  random: () => 0.5,
};

test("exponential backoff uses deterministic jitter and cap", () => {
  assert.equal(retryDelayMs(1, 100, 1_000, () => 0.5), 100);
  assert.equal(retryDelayMs(2, 100, 1_000, () => 0.5), 200);
  assert.equal(retryDelayMs(3, 100, 1_000, () => 0.5), 400);
  assert.equal(retryDelayMs(6, 100, 1_000, () => 0.5), 1_000);
});

test("jitter remains within 0.8 to 1.2 bounds", () => {
  assert.equal(retryDelayMs(1, 100, 1_000, () => 0), 80);
  assert.equal(retryDelayMs(1, 100, 1_000, () => 1), 120);
});

test("transient failures retry up to maximum attempts", async () => {
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(
    retry(async () => {
      attempts += 1;
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    }, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      isRetryable: () => true,
      onRetry: (event) => delays.push(event.delayMs),
      ...immediateTimers,
    }),
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test("permanent failures never retry", async () => {
  let attempts = 0;
  const failure = new Error("invalid request");
  await assert.rejects(retry(async () => {
    attempts += 1;
    throw failure;
  }, {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    isRetryable: () => false,
    ...immediateTimers,
  }), failure);
  assert.equal(attempts, 1);
});

test("retry budget prevents an additional attempt", async () => {
  let attempts = 0;
  await assert.rejects(retry(async () => {
    attempts += 1;
    throw new Error("temporary");
  }, {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    retryBudgetMs: 50,
    isRetryable: () => true,
    now: () => 0,
    ...immediateTimers,
  }));
  assert.equal(attempts, 1);
});

test("AbortSignal cancels backoff and clears its timer", async () => {
  const controller = new AbortController();
  let timer: (() => void) | undefined;
  let cleared = 0;
  const pending = retry(async () => { throw new Error("temporary"); }, {
    maxAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    signal: controller.signal,
    isRetryable: () => true,
    setTimer: (callback) => { timer = callback; return 1; },
    clearTimer: () => { cleared += 1; },
  });
  await Promise.resolve();
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  assert.equal(cleared, 1);
  timer?.();
});

test("deadline prevents sleeping beyond remaining request time", async () => {
  const deadline = createDeadline(50, {
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  await assert.rejects(retry(async () => { throw new Error("temporary"); }, {
    maxAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    deadline,
    isRetryable: () => true,
    random: () => 0.5,
  }), DeadlineExceededError);
  deadline.dispose();
});

test("retry logging contains only bounded safe fields and metrics record outcomes", async () => {
  const entries: Array<Record<string, unknown>> = [];
  const metrics = new MetricsRegistry();
  const observer = createRetryObservability({
    category: "database",
    operation: "semantic_search",
    logger: { info: (event, fields) => entries.push({ event, ...fields }) },
    metrics,
    fields: { requestId: "request-1" },
  });
  let attempts = 0;
  const result = await retry(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary secret query");
    return "ok";
  }, {
    maxAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    isRetryable: () => true,
    ...observer,
    ...immediateTimers,
  });
  assert.equal(result, "ok");
  assert.deepEqual(Object.keys(entries[0] ?? {}).sort(), ["attempt", "category", "delayMs", "event", "maxAttempts", "operation", "requestId"]);
  assert.equal(JSON.stringify(entries).includes("secret query"), false);
  assert.match(metrics.render(), /giro_retries_total\{category="database",result="scheduled",attempt="1"\} 1/);
  assert.match(metrics.render(), /giro_retries_total\{category="database",result="succeeded",attempt="2"\} 1/);
});

test("OpenAI retries transient stream creation with SDK retries disabled", async () => {
  let attempts = 0;
  const requestOptions: Array<Record<string, unknown>> = [];
  const stream = { async *[Symbol.asyncIterator]() { yield { choices: [{ delta: { content: "done" } }] }; } };
  const client = {
    chat: { completions: { create: async (_body: unknown, options: Record<string, unknown>) => {
      attempts += 1;
      requestOptions.push(options);
      if (attempts === 1) throw new APIConnectionError({ message: "reset" });
      return stream;
    } } },
  } as unknown as OpenAI;
  const output = await streamCompletion([], {
    client,
    logger: { info: () => undefined },
    metrics: new MetricsRegistry(),
    retryRuntime: immediateTimers,
  });
  const chunks: string[] = [];
  for await (const chunk of output) chunks.push(chunk);
  assert.equal(attempts, 2);
  assert.deepEqual(chunks, ["done"]);
  assert.equal(requestOptions.every((options) => options.maxRetries === 0), true);
});

test("OpenAI permanent request error is attempted once", async () => {
  let attempts = 0;
  const client = {
    chat: { completions: { create: async () => {
      attempts += 1;
      throw APIError.generate(400, {}, "bad request", new Headers());
    } } },
  } as unknown as OpenAI;
  await assert.rejects(streamCompletion([], {
    client,
    logger: { info: () => undefined },
    metrics: new MetricsRegistry(),
    retryRuntime: immediateTimers,
  }));
  assert.equal(attempts, 1);
});

test("embedding and database classifiers distinguish transient and permanent failures", () => {
  assert.equal(isTransientEmbeddingError(new APIConnectionError({ message: "network" })), true);
  assert.equal(isTransientEmbeddingError(APIError.generate(401, {}, "unauthorized", new Headers())), false);
  assert.equal(isTransientDatabaseError({ code: "08006" }), true);
  assert.equal(isTransientDatabaseError({ code: "23505" }), false);
  assert.equal(isTransientDatabaseError({ code: "42501" }), false);
});

test("embedding provider retries transient failure without duplicating success", async () => {
  let attempts = 0;
  const client = {
    embeddings: { create: async () => {
      attempts += 1;
      if (attempts === 1) throw new APIConnectionError({ message: "reset" });
      return { data: [{ embedding: [0.1, 0.2] }] };
    } },
  } as unknown as OpenAI;
  const vector = await requestOpenAIEmbedding("safe input", {
    client,
    logger: { info: () => undefined },
    metrics: new MetricsRegistry(),
    retryRuntime: immediateTimers,
  });
  assert.equal(attempts, 2);
  assert.deepEqual(vector, [0.1, 0.2]);
});

test("database read retries transient transport errors only", async () => {
  let attempts = 0;
  const deadline = createDeadline(10_000);
  const result = await retryDatabaseRead(async () => {
    attempts += 1;
    return attempts === 1
      ? { data: null, error: { code: "PGRST000" } }
      : { data: ["row"], error: null };
  }, {
    deadline,
    operation: "test_read",
    logger: { info: () => undefined },
    metrics: new MetricsRegistry(),
    retryRuntime: immediateTimers,
  });
  deadline.dispose();
  assert.equal(attempts, 2);
  assert.deepEqual(result.data, ["row"]);
});

test("clone retries transient network failure after cleanup but not permanent failures", async () => {
  let transientAttempts = 0;
  const cloned = await cloneRepo("retry-test-owner", "retry-test-repo", {
    executeClone: async () => {
      transientAttempts += 1;
      if (transientAttempts === 1) throw new Error("fatal: unable to access: connection reset");
    },
    logger: { info: () => undefined },
    metrics: new MetricsRegistry(),
    retryRuntime: immediateTimers,
    checkoutSnapshot: async () => ({ commitSha: "a".repeat(40), branch: "main" }),
  });
  assert.equal(transientAttempts, 2);
  assert.equal(cloned.alreadyExisted, false);
  assert.equal(cloned.commitSha, "a".repeat(40));

  let permanentAttempts = 0;
  await assert.rejects(cloneRepo("retry-test-owner", "missing-repo", {
    executeClone: async () => {
      permanentAttempts += 1;
      throw new Error("remote: Repository not found");
    },
    logger: { info: () => undefined },
    metrics: new MetricsRegistry(),
    retryRuntime: immediateTimers,
  }));
  assert.equal(permanentAttempts, 1);
  assert.equal(isTransientCloneError(new Error("authentication failed")), false);
});

test("worker stage-local retries preserve one claim and one successful lifecycle", async () => {
  const store = new MemoryIndexingJobStore();
  const job = await store.createJob({
    repositoryId: "acme/retry-worker",
    ownerUserId: "user-1",
    repositoryOwner: "acme",
    repositoryName: "retry-worker",
    repositoryUrl: "https://github.com/acme/retry-worker",
    branch: "main",
  });
  let stageAttempts = 0;
  const report = await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    repositoryStore: {
      markIndexing: () => undefined,
      markIndexed: () => undefined,
      markFailed: () => undefined,
    },
    executeIndexingPipeline: async () => {
      await retry(async () => {
        stageAttempts += 1;
        if (stageAttempts === 1) throw new Error("temporary");
      }, {
        maxAttempts: 2,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        isRetryable: () => true,
        ...immediateTimers,
      });
      return {
        counts: {
          chunkCount: 0,
          fileCount: 0,
          symbolCount: 0,
          graphNodeCount: 0,
          graphEdgeCount: 0,
          summaryAvailable: false,
        },
      };
    },
  });
  assert.equal(stageAttempts, 2);
  assert.equal(report.status, "succeeded");
  assert.equal((await store.getJob(job.jobId))?.attempt, 1);
  assert.equal((await store.getJob(job.jobId))?.status, "succeeded");
  assert.equal(await store.claimNextJob("worker-2"), null);
});
