import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
  createLogger,
  runWithLogContext,
} from "../lib/logger.js";
import {
  createRequestContextMiddleware,
  type RequestContextVariables,
} from "../middleware/requestContext.js";

function capturingLogger() {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line), {
    level: "debug",
    now: () => new Date("2026-07-20T12:00:00.000Z"),
  });
  return { logger, lines };
}

test("structured logger emits stable JSON fields for every level", () => {
  const { logger, lines } = capturingLogger();
  runWithLogContext({ requestId: "req-1", userId: "user-1" }, () => {
    logger.debug("debug_operation", { repositoryId: "acme/repo" });
    logger.info("info_operation", { sessionId: "session-1" });
    logger.warn("warn_operation", { workerId: "worker-1" });
    logger.error("error_operation");
  });

  assert.equal(lines.length, 4);
  const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(entries.map((entry) => entry.level), ["debug", "info", "warn", "error"]);
  assert.equal(entries[0]?.timestamp, "2026-07-20T12:00:00.000Z");
  assert.equal(entries[0]?.operation, "debug_operation");
  assert.equal(entries[0]?.requestId, "req-1");
  assert.equal(entries[0]?.userId, "user-1");
  assert.equal(entries[0]?.repositoryId, "acme/repo");
  assert.equal(entries[1]?.sessionId, "session-1");
  assert.equal(entries[2]?.workerId, "worker-1");
});

test("logger redacts sensitive fields and secret-shaped text recursively", () => {
  const { logger, lines } = capturingLogger();
  logger.info("safe_operation", {
    authorization: "Bearer auth-secret",
    openaiApiKey: "sk-openai-secret-value",
    supabaseServiceRoleKey: "service-secret",
    jwtToken: "eyJheader.payload.signature",
    prompt: "private prompt contents",
    embeddings: [0.1, 0.2],
    repositorySourceCode: "const privateValue = true;",
    nested: { accessToken: "nested-secret" },
    errorMessage: "provider returned sk-another-secret-value",
  });

  const serialized = lines[0] ?? "";
  for (const secret of [
    "auth-secret",
    "sk-openai-secret-value",
    "service-secret",
    "eyJheader.payload.signature",
    "private prompt contents",
    "0.1",
    "privateValue",
    "nested-secret",
    "sk-another-secret-value",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.ok(serialized.includes("[REDACTED]"));
});

test("request correlation propagates to logs produced inside request handling", async () => {
  const { logger, lines } = capturingLogger();
  const app = new Hono<{ Variables: RequestContextVariables }>();
  app.use("*", createRequestContextMiddleware({ logger, monotonicNow: () => 10 }));
  app.get("/work", (c) => {
    logger.info("nested_request_work");
    return c.text("ok");
  });

  await app.request("/work", { headers: { "X-Request-ID": "propagated-id" } });

  const nested = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.operation === "nested_request_work");
  assert.equal(nested?.requestId, "propagated-id");
});

test("error logging retains an internal redacted stack", () => {
  const { logger, lines } = capturingLogger();
  logger.error("unexpected_exception", {
    error: new Error("request failed with sk-private-secret"),
  });

  const entry = JSON.parse(lines[0] ?? "{}") as {
    error?: { name?: string; message?: string; stack?: string };
  };
  assert.equal(entry.error?.name, "Error");
  assert.equal(entry.error?.message, "request failed with [REDACTED]");
  assert.equal(typeof entry.error?.stack, "string");
  assert.equal(entry.error?.stack?.includes("sk-private-secret"), false);
});
