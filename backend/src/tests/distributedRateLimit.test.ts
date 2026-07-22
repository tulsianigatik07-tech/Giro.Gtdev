import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Hono } from "hono";

import { rateLimiter } from "../middleware/rateLimiter.js";
import { normalizeIpAddress, resolveClientIp } from "../middleware/trustedProxy.js";
import { MemoryRateLimitStore } from "../services/rateLimit/memoryRateLimitStore.js";
import { SupabaseRateLimitStore } from "../services/rateLimit/supabaseRateLimitStore.js";

function limitedApp(store: MemoryRateLimitStore, maxRequests = 1) {
  const app = new Hono();
  app.use("*", rateLimiter({ windowMs: 60_000, maxRequests, store }));
  app.get("/limited", (c) => c.text("ok"));
  return app;
}

test("memory store increments atomically across concurrent requests", async () => {
  const store = new MemoryRateLimitStore();
  const results = await Promise.all(Array.from({ length: 100 }, () => store.increment({
    key: "a".repeat(64), windowMs: 60_000, nowMs: 1_000,
  })));
  assert.deepEqual(results.map((result) => result.count).sort((a, b) => a - b),
    Array.from({ length: 100 }, (_, index) => index + 1));
});

test("concurrent middleware requests share one distributed limit", async () => {
  const store = new MemoryRateLimitStore();
  const replicas = [limitedApp(store, 5), limitedApp(store, 5)];
  const responses = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    replicas[index % replicas.length]!.request("/limited")));
  assert.equal(responses.filter((response) => response.status === 200).length, 5);
  assert.equal(responses.filter((response) => response.status === 429).length, 15);
});

test("multiple replicas observe the same bucket", async () => {
  const store = new MemoryRateLimitStore();
  const firstReplica = limitedApp(store);
  const secondReplica = limitedApp(store);
  assert.equal((await firstReplica.request("/limited")).status, 200);
  assert.equal((await secondReplica.request("/limited")).status, 429);
});

test("fixed windows expire deterministically", async () => {
  const store = new MemoryRateLimitStore();
  const first = await store.increment({ key: "b".repeat(64), windowMs: 1_000, nowMs: 5_000 });
  const second = await store.increment({ key: "b".repeat(64), windowMs: 1_000, nowMs: 5_999 });
  const expired = await store.increment({ key: "b".repeat(64), windowMs: 1_000, nowMs: 6_000 });
  assert.deepEqual([first.count, second.count, expired.count], [1, 2, 1]);
  assert.equal(expired.resetAt, 7_000);
});

test("trusted proxy chains resolve the first untrusted hop", () => {
  assert.equal(resolveClientIp({
    remoteAddress: "10.0.0.5",
    forwardedFor: "198.51.100.8, 10.1.2.3",
    trustedProxyCidrs: ["10.0.0.0/8", "2001:db8::/32"],
  }), "198.51.100.8");
  assert.equal(resolveClientIp({
    remoteAddress: "2001:db8::5",
    forwardedFor: "2001:db9::8",
    trustedProxyCidrs: ["2001:db8::/32"],
  }), "2001:db9:0:0:0:0:0:8");
  assert.equal(normalizeIpAddress("::ffff:192.0.2.10"), "192.0.2.10");
});

test("untrusted peers cannot spoof X-Forwarded-For", async () => {
  const store = new MemoryRateLimitStore();
  const app = limitedApp(store);
  assert.equal((await app.request("/limited", {
    headers: { "x-forwarded-for": "203.0.113.1" },
  })).status, 200);
  assert.equal((await app.request("/limited", {
    headers: { "x-forwarded-for": "203.0.113.2" },
  })).status, 429);
});

test("configured burst is reflected in preserved headers", async () => {
  const app = new Hono();
  app.use("*", rateLimiter({ windowMs: 60_000, maxRequests: 1, burst: 2 }));
  app.get("/limited", (c) => c.text("ok"));
  const responses = await Promise.all(Array.from({ length: 4 }, () => app.request("/limited")));
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 429]);
  assert.equal(responses[0]!.headers.get("X-RateLimit-Limit"), "3");
});

test("memory and Supabase stores expose equivalent increment results", async () => {
  let count = 0;
  const client = {
    async rpc(name: string) {
      if (name === "verify_rate_limit_backend") return { data: true, error: null };
      count += 1;
      return { data: [{ request_count: count, reset_at: "2026-07-22T08:00:00.000Z" }], error: null };
    },
  };
  const supabase = new SupabaseRateLimitStore(client);
  await supabase.verify();
  const result = await supabase.increment({ key: "c".repeat(64), windowMs: 60_000 });
  assert.deepEqual(result, { count: 1, resetAt: Date.parse("2026-07-22T08:00:00.000Z") });
  assert.equal((await supabase.increment({ key: "c".repeat(64), windowMs: 60_000 })).count, 2);
});

test("migration defines atomic increment, expiration, validation, and restricted RPCs", async () => {
  const sql = (await readFile(new URL(
    "../../supabase/migrations/20260728000000_add_distributed_rate_limits.sql",
    import.meta.url,
  ), "utf8")).toLowerCase();
  for (const contract of [
    "create table if not exists public.rate_limit_buckets",
    "primary key",
    "on conflict (bucket_key) do update",
    "request_count + 1",
    "reset_at <= effective_now",
    "rate_limit_buckets_expiration_idx",
    "limit 100",
    "verify_rate_limit_backend",
    "grant execute",
    "service_role",
  ]) assert.ok(sql.includes(contract), `missing rate-limit migration contract: ${contract}`);
});
