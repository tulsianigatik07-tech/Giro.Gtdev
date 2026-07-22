import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
  createRateLimitMiddleware,
  rateLimiter,
  type RateLimitPolicy,
} from "../middleware/rateLimiter.js";
import { setAuthenticatedUser } from "../services/auth/authContext.js";

function createTestApp(options: Parameters<typeof rateLimiter>[0]) {
  const app = new Hono();
  app.use("/limited", async (c, next) => {
    const userId = c.req.header("x-test-user");
    if (userId) setAuthenticatedUser(c, { userId, email: `${userId}@test.dev` });
    await next();
  });
  app.use("/limited", rateLimiter({ trustedProxyCidrs: ["127.0.0.1/32", "10.0.0.0/8"], ...options }));
  app.get("/limited", (c) => c.json({ success: true }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  return app;
}

test("allows requests under the limit and returns rate limit headers", async () => {
  const app = createTestApp({ windowMs: 60_000, maxRequests: 2 });
  const response = await app.request("/limited");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RateLimit-Limit"), "2");
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "1");
  assert.equal(response.headers.get("Retry-After"), "60");
});

test("returns a safe 429 response after the limit is exceeded", async () => {
  const app = createTestApp({ windowMs: 60_000, maxRequests: 1 });
  await app.request("/limited");
  const response = await app.request("/limited");
  const body = await response.json() as { error: { code: string; message: string } };

  assert.equal(response.status, 429);
  assert.deepEqual(body.error, {
    code: "rate_limit_exceeded",
    message: "Too many requests. Please try again later.",
  });
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "0");
  assert.equal(response.headers.get("Retry-After"), "60");
});

test("resets counters when the configured window expires", async () => {
  let timestamp = 1_000;
  const app = createTestApp({ windowMs: 1_000, maxRequests: 1, now: () => timestamp });
  await app.request("/limited");
  assert.equal((await app.request("/limited")).status, 429);
  timestamp = 2_000;
  assert.equal((await app.request("/limited")).status, 200);
});

test("isolates authenticated users", async () => {
  const app = createTestApp({ windowMs: 60_000, maxRequests: 1 });
  await app.request("/limited", { headers: { "x-test-user": "user-a" } });
  assert.equal((await app.request("/limited", { headers: { "x-test-user": "user-a" } })).status, 429);
  assert.equal((await app.request("/limited", { headers: { "x-test-user": "user-b" } })).status, 200);
});

test("uses the first forwarded IP when no user is authenticated", async () => {
  const app = createTestApp({ windowMs: 60_000, maxRequests: 1 });
  await app.request("/limited", { headers: { "x-forwarded-for": "203.0.113.1, 10.0.0.1" } });
  assert.equal((await app.request("/limited", { headers: { "x-forwarded-for": "203.0.113.1" } })).status, 429);
  assert.equal((await app.request("/limited", { headers: { "x-forwarded-for": "203.0.113.2" } })).status, 200);
});

test("authenticated limits use the user bucket independently of IP", async () => {
  const app = createTestApp({ windowMs: 60_000, maxRequests: 1 });
  await app.request("/limited", { headers: { "x-test-user": "user-a", "x-forwarded-for": "203.0.113.1" } });
  assert.equal((await app.request("/limited", { headers: { "x-test-user": "user-a", "x-forwarded-for": "203.0.113.1" } })).status, 429);
  assert.equal((await app.request("/limited", { headers: { "x-test-user": "user-a", "x-forwarded-for": "203.0.113.2" } })).status, 429);
});

test("authenticated and anonymous requests from the same IP are isolated", async () => {
  const app = createTestApp({ windowMs: 60_000, maxRequests: 1 });
  const ip = { "x-forwarded-for": "203.0.113.10" };
  await app.request("/limited", { headers: ip });
  assert.equal((await app.request("/limited", { headers: ip })).status, 429);
  assert.equal((await app.request("/limited", {
    headers: { ...ip, "x-test-user": "user-a" },
  })).status, 200);
});

test("does not affect routes where middleware is not registered", async () => {
  const app = createTestApp({ windowMs: 60_000, maxRequests: 1 });
  await app.request("/limited");
  await app.request("/limited");
  assert.equal((await app.request("/health")).status, 200);
  assert.equal((await app.request("/health")).headers.get("X-RateLimit-Limit"), null);
});

test("supports a custom key generator", async () => {
  const app = createTestApp({
    windowMs: 60_000,
    maxRequests: 1,
    keyGenerator: (c) => c.req.header("x-api-key") ?? "anonymous",
  });
  await app.request("/limited", { headers: { "x-api-key": "key-a" } });
  assert.equal((await app.request("/limited", { headers: { "x-api-key": "key-a" } })).status, 429);
  assert.equal((await app.request("/limited", { headers: { "x-api-key": "key-b" } })).status, 200);
});

test("supports a custom skip callback and message", async () => {
  const app = createTestApp({
    windowMs: 60_000,
    maxRequests: 1,
    skip: (c) => c.req.header("x-internal") === "true",
    message: "Request limit reached.",
  });
  await app.request("/limited", { headers: { "x-internal": "true" } });
  await app.request("/limited", { headers: { "x-internal": "true" } });
  assert.equal((await app.request("/limited")).status, 200);
  const response = await app.request("/limited");
  assert.equal(response.status, 429);
  assert.equal(((await response.json()) as { error: { message: string } }).error.message, "Request limit reached.");
});

function policy(maxRequests = 1): RateLimitPolicy {
  const rule = { windowMs: 60_000, maxRequests };
  return {
    authentication: { ...rule },
    repositoryConnect: { ...rule },
    askGiro: { ...rule },
    retrievalSearch: { ...rule },
    indexingOperations: { ...rule },
    defaultApi: { ...rule },
  };
}

function createBucketApp(rateLimitPolicy: RateLimitPolicy) {
  const app = new Hono();
  app.use("*", createRateLimitMiddleware({ policy: rateLimitPolicy }));
  for (const path of [
    "/auth/login",
    "/repos/connect",
    "/sessions/session-1/ask",
    "/search/context",
    "/indexing/jobs/job-1",
    "/other",
  ]) {
    app.get(path, (c) => c.json({ success: true }));
  }
  return app;
}

test("route classes maintain independent rate-limit buckets", async () => {
  const app = createBucketApp(policy(1));
  const paths = [
    "/auth/login",
    "/repos/connect",
    "/sessions/session-1/ask",
    "/search/context",
    "/indexing/jobs/job-1",
    "/other",
  ];

  for (const path of paths) {
    assert.equal((await app.request(path)).status, 200, `${path} first request`);
  }
  for (const path of paths) {
    assert.equal((await app.request(path)).status, 429, `${path} second request`);
  }
});

test("per-bucket configuration overrides control limits and headers", async () => {
  const configured = policy(5);
  configured.authentication.maxRequests = 2;
  configured.repositoryConnect.maxRequests = 3;
  const app = createBucketApp(configured);

  const authFirst = await app.request("/auth/login");
  assert.equal(authFirst.headers.get("X-RateLimit-Limit"), "2");
  assert.equal((await app.request("/auth/login")).status, 200);
  assert.equal((await app.request("/auth/login")).status, 429);

  const connectFirst = await app.request("/repos/connect");
  assert.equal(connectFirst.headers.get("X-RateLimit-Limit"), "3");
  assert.equal((await app.request("/repos/connect")).status, 200);
  assert.equal((await app.request("/repos/connect")).status, 200);
  assert.equal((await app.request("/repos/connect")).status, 429);
});

test("violations are logged without exposing the internal identity key", async () => {
  const entries: Array<{ operation: string; fields?: Record<string, unknown> }> = [];
  const app = new Hono();
  app.use("*", createRateLimitMiddleware({
    policy: policy(1),
    logger: {
      warn: (operation, fields) => entries.push({ operation, fields }),
    },
  }));
  app.get("/other", (c) => c.text("ok"));
  const headers = { "x-forwarded-for": "203.0.113.20" };

  await app.request("/other", { headers });
  await app.request("/other", { headers });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.operation, "rate_limit_exceeded");
  assert.equal(entries[0]?.fields?.rateLimitBucket, "defaultApi");
  assert.equal(JSON.stringify(entries).includes("203.0.113.20"), false);
});
