import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { createApp } from "../app.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { DeadlineExceededError } from "../runtime/deadline.js";
import { signAccessToken } from "../services/auth/jwt.js";
import { MemoryIndexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import { processNextIndexingJob } from "../services/indexing/jobs/indexingJobWorker.js";
import {
  RetrievalCache,
  buildRetrievalCacheKey,
} from "../services/retrieval/cache/retrievalCache.js";
import { hybridSearch } from "../services/retrieval/hybridSearch.js";
import {
  clearRepositoryIndexRegistry,
  setRepositoryIndexed,
} from "../services/repository/indexingService.js";
import {
  clearRepositoryOwners,
  setRepositoryOwner,
} from "../services/repository/ownershipStore.js";

const REPOSITORY_ID = "acme/cache-demo";
const KEY = {
  repositoryId: REPOSITORY_ID,
  query: "how does retrieval work?",
  mode: "hybrid",
  limits: { requested: 10, effective: 10 },
  selectedContext: [{ filePath: "src/a.ts", startLine: 1 }],
  options: { minScore: 0.5, sources: ["semantic", "keyword"] },
};

type LogEntry = { event: string; fields?: Record<string, unknown> };

function createCache(options: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  versionProvider?: (repositoryId: string) => string | Promise<string>;
} = {}) {
  const metrics = new MetricsRegistry();
  const logs: LogEntry[] = [];
  const cache = new RetrievalCache({
    ttlMs: options.ttlMs ?? 1_000,
    maxEntries: options.maxEntries ?? 10,
    now: options.now,
    versionProvider: options.versionProvider,
    metrics,
    logger: { info: (event, fields) => { logs.push({ event, fields }); } },
  });
  return { cache, metrics, logs };
}

async function loadValue(cache: RetrievalCache, value: unknown, key = KEY) {
  return cache.getOrLoad(key, async () => value);
}

beforeEach(() => {
  clearRepositoryOwners();
  clearRepositoryIndexRegistry();
});

test("deterministic keys normalize whitespace and stable object ordering", () => {
  const first = buildRetrievalCacheKey(KEY);
  const second = buildRetrievalCacheKey({
    ...KEY,
    repositoryId: " ACME/cache-demo ",
    query: "how   does\nretrieval work?",
    limits: { effective: 10, requested: 10 },
    options: { sources: ["semantic", "keyword"], minScore: 0.5 },
  });
  assert.equal(second, first);
  assert.notEqual(buildRetrievalCacheKey({ ...KEY, query: "HOW does retrieval work?" }), first);
});

test("cache miss loads once and cache hit returns the immutable cached value", async () => {
  const { cache, metrics, logs } = createCache();
  let calls = 0;
  const source = { results: [{ filePath: "src/a.ts", content: "safe" }] };
  const loader = async () => {
    calls += 1;
    return source;
  };

  const first = await cache.getOrLoad(KEY, loader);
  source.results[0]!.content = "mutated";
  const second = await cache.getOrLoad(KEY, loader);

  assert.equal(calls, 1);
  assert.strictEqual(second, first);
  assert.equal(second.results[0]?.content, "safe");
  assert.equal(Object.isFrozen(second), true);
  assert.equal(Object.isFrozen(second.results), true);
  assert.throws(() => second.results.push({ filePath: "x", content: "x" }));
  const output = metrics.render();
  assert.match(output, /giro_retrieval_cache_hits_total 1/);
  assert.match(output, /giro_retrieval_cache_misses_total 1/);
  assert.match(output, /giro_retrieval_cache_entries 1/);
  assert.deepEqual(logs.map((entry) => entry.event), [
    "retrieval_cache_miss",
    "retrieval_cache_hit",
  ]);
  assert.equal(JSON.stringify(logs).includes(KEY.query), false);
  assert.equal(JSON.stringify(logs).includes("safe"), false);
});

test("TTL expiry is removed lazily and never served", async () => {
  let now = 1_000;
  const { cache, metrics, logs } = createCache({ ttlMs: 10, now: () => now });
  let calls = 0;
  const loader = async () => ({ generation: ++calls });
  assert.equal((await cache.getOrLoad(KEY, loader)).generation, 1);
  now = 1_010;
  assert.equal((await cache.getOrLoad(KEY, loader)).generation, 2);
  assert.match(metrics.render(), /giro_retrieval_cache_evictions_total 1/);
  assert.equal(logs.some((entry) => entry.event === "retrieval_cache_evicted" && entry.fields?.reason === "expired"), true);
});

test("LRU capacity eviction retains the most recently used entry", async () => {
  const { cache, metrics } = createCache({ maxEntries: 2 });
  const key = (query: string) => ({ ...KEY, query });
  await loadValue(cache, "a", key("a"));
  await loadValue(cache, "b", key("b"));
  await loadValue(cache, "a-unused", key("a"));
  await loadValue(cache, "c", key("c"));
  let calls = 0;
  const b = await cache.getOrLoad(key("b"), async () => { calls += 1; return "b-new"; });
  assert.equal(b, "b-new");
  assert.equal(calls, 1);
  assert.match(metrics.render(), /giro_retrieval_cache_evictions_total 2/);
  assert.equal(cache.size(), 2);
});

test("manual repository invalidation removes only that repository", async () => {
  const { cache, logs } = createCache();
  await loadValue(cache, "a");
  await loadValue(cache, "b", { ...KEY, repositoryId: "acme/other" });
  assert.equal(cache.invalidateRepository(REPOSITORY_ID), 1);
  assert.equal(cache.size(), 1);
  assert.equal(logs.at(-1)?.event, "retrieval_cache_invalidated");
  assert.equal(logs.at(-1)?.fields?.reason, "manual");
});

test("repository version changes invalidate prior retrieval results", async () => {
  let version = "v1";
  const { cache, logs } = createCache({ versionProvider: () => version });
  let calls = 0;
  const loader = async () => ({ version, call: ++calls });
  assert.equal((await cache.getOrLoad(KEY, loader)).call, 1);
  assert.equal((await cache.getOrLoad(KEY, loader)).call, 1);
  version = "v2";
  assert.equal((await cache.getOrLoad(KEY, loader)).call, 2);
  assert.equal(logs.some((entry) => entry.event === "retrieval_cache_invalidated" && entry.fields?.reason === "repository_version_changed"), true);
});

test("concurrent identical requests share one retrieval and one immutable result", async () => {
  const { cache, metrics } = createCache();
  let resolve!: (value: { results: string[] }) => void;
  const pending = new Promise<{ results: string[] }>((done) => { resolve = done; });
  let calls = 0;
  const loader = async () => { calls += 1; return pending; };
  const first = cache.getOrLoad(KEY, loader);
  const second = cache.getOrLoad(KEY, loader);
  resolve({ results: ["one"] });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.strictEqual(a, b);
  assert.equal(Object.isFrozen(a.results), true);
  assert.match(metrics.render(), /giro_retrieval_cache_hits_total 1/);
});

test("hybrid retrieval uses the injected cache without changing response echoes", async () => {
  const { cache } = createCache();
  let calls = 0;
  const execute = async (request: { query: string; owner: string; repo: string }) => {
    calls += 1;
    return {
      query: request.query,
      repository: `${request.owner}/${request.repo}`,
      results: [],
      stats: {
        semanticResults: 0,
        keywordResults: 0,
        symbolResults: 0,
        graphBoosted: 0,
        returned: 0,
      },
    };
  };
  const first = await hybridSearch(
    { query: "cache   this", owner: "acme", repo: "cache-demo", limit: 5 },
    { cache, execute },
  );
  const second = await hybridSearch(
    { query: "cache this", owner: "acme", repo: "cache-demo", limit: 5 },
    { cache, execute },
  );
  assert.equal(calls, 1);
  assert.equal(first.query, "cache   this");
  assert.equal(second.query, "cache this");
  assert.equal(Object.isFrozen(second), true);
});

test("failures and timeouts never populate the cache", async () => {
  const { cache } = createCache();
  let failures = 0;
  const failing = async () => { failures += 1; throw new Error("failed"); };
  await assert.rejects(cache.getOrLoad(KEY, failing), /failed/);
  await assert.rejects(cache.getOrLoad(KEY, failing), /failed/);
  let timeouts = 0;
  const timeout = async () => { timeouts += 1; throw new DeadlineExceededError(); };
  await assert.rejects(cache.getOrLoad({ ...KEY, query: "timeout" }, timeout));
  await assert.rejects(cache.getOrLoad({ ...KEY, query: "timeout" }, timeout));
  assert.equal(failures, 2);
  assert.equal(timeouts, 2);
  assert.equal(cache.size(), 0);
});

test("a cancelled sole request aborts shared work and does not populate cache", async () => {
  const { cache } = createCache();
  const caller = new AbortController();
  let observedAbort = false;
  const pending = cache.getOrLoad(
    KEY,
    (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(signal.reason);
      }, { once: true });
    }),
    { signal: caller.signal },
  );
  caller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observedAbort, true);
  assert.equal(cache.size(), 0);
  assert.equal(await loadValue(cache, "fresh"), "fresh");
});

test("index completion hook invalidates cached repository retrieval", async () => {
  const store = new MemoryIndexingJobStore();
  await store.createJob({
    repositoryId: REPOSITORY_ID,
    ownerUserId: "user-a",
    repositoryOwner: "acme",
    repositoryName: "cache-demo",
    repositoryUrl: "https://github.com/acme/cache-demo",
  });
  setRepositoryOwner(REPOSITORY_ID, "user-a");
  const { cache, logs } = createCache();
  await loadValue(cache, "before");
  await processNextIndexingJob({
    workerId: "worker-1",
    jobStore: store,
    retrievalCacheInvalidator: cache,
    repositoryStore: {
      markIndexing: () => undefined,
      markIndexed: () => undefined,
      markFailed: () => undefined,
    },
    executeIndexingPipeline: async () => ({
      counts: {
        chunkCount: 0,
        fileCount: 0,
        symbolCount: 0,
        graphNodeCount: 0,
        graphEdgeCount: 0,
        summaryAvailable: false,
      },
    }),
  });
  assert.equal(cache.size(), 0);
  assert.equal(logs.some((entry) => entry.event === "retrieval_cache_invalidated" && entry.fields?.reason === "indexing_completed"), true);
});

test("repository deletion route invalidates the injected retrieval cache", async () => {
  const store = new MemoryIndexingJobStore();
  const { cache } = createCache();
  await loadValue(cache, "cached");
  setRepositoryOwner(REPOSITORY_ID, "user-a");
  setRepositoryIndexed("acme", "cache-demo", {
    chunkCount: 0,
    fileCount: 0,
    symbolCount: 0,
    graphNodeCount: 0,
    graphEdgeCount: 0,
    summaryAvailable: false,
  });
  const token = await signAccessToken({ userId: "user-a", email: "a@example.com" });
  const response = await createApp({
    indexingJobStore: store,
    retrievalCache: cache,
  }).request("/repos/acme/cache-demo", {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(cache.size(), 0);
});
