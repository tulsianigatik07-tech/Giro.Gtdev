import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  EnvironmentValidationError,
  env,
  validateEnv,
} from "../config/env.js";

const REQUIRED = {
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  OPENAI_API_KEY: "sk-test-configuration-key",
};

test("valid configuration is parsed and normalized", () => {
  const result = validateEnv({
    ...REQUIRED,
    NODE_ENV: "production",
    PORT: "9000",
    CORS_ORIGINS: "https://giro.dev, https://app.giro.dev",
    LOG_LEVEL: "warn",
    JWT_SECRET: "a-production-secret",
    EMBEDDINGS_PROVIDER: "openai",
    MODEL_NAME: "gpt-test",
    INDEXING_WORKER_ID: "worker-1",
  });

  assert.equal(result.NODE_ENV, "production");
  assert.equal(result.PORT, 9000);
  assert.deepEqual(result.CORS_ORIGINS, ["https://giro.dev", "https://app.giro.dev"]);
  assert.equal(result.EMBEDDINGS_PROVIDER, "openai");
  assert.equal(result.MODEL_NAME, "gpt-test");
  assert.equal(result.INDEXING_WORKER_ID, "worker-1");
  assert.equal(Object.isFrozen(result), true);
});

test("missing required variables produce one safe validation error", () => {
  assert.throws(
    () => validateEnv({}),
    (error: unknown) => {
      assert.ok(error instanceof EnvironmentValidationError);
      assert.equal(
        error.message,
        "Invalid environment configuration: OPENAI_API_KEY, SUPABASE_URL.",
      );
      assert.equal(error.message.includes("service-role-key"), false);
      return true;
    },
  );
});

test("missing both Supabase key variants is rejected", () => {
  assert.throws(
    () => validateEnv({
      SUPABASE_URL: REQUIRED.SUPABASE_URL,
      OPENAI_API_KEY: REQUIRED.OPENAI_API_KEY,
    }),
    (error: unknown) => {
      assert.ok(error instanceof EnvironmentValidationError);
      assert.deepEqual(Object.keys(error.issues), ["SUPABASE_SERVICE_ROLE_KEY"]);
      return true;
    },
  );
});

test("invalid enum values are rejected", () => {
  assert.throws(
    () => validateEnv({
      ...REQUIRED,
      NODE_ENV: "staging",
      EMBEDDINGS_PROVIDER: "vector-cloud",
    }),
    (error: unknown) => {
      assert.ok(error instanceof EnvironmentValidationError);
      assert.deepEqual(Object.keys(error.issues), ["EMBEDDINGS_PROVIDER", "NODE_ENV"]);
      return true;
    },
  );
});

test("defaults preserve existing runtime behavior", () => {
  const result = validateEnv(REQUIRED);

  assert.equal(result.NODE_ENV, "development");
  assert.equal(result.PORT, 8000);
  assert.deepEqual(result.CORS_ORIGINS, ["http://localhost:3000"]);
  assert.equal(result.LOG_LEVEL, "info");
  assert.equal(result.JWT_SECRET, "dev-insecure-secret-change-me");
  assert.equal(result.EMBEDDINGS_PROVIDER, "mock");
  assert.equal(result.MODEL_NAME, "gpt-4.1-mini");
  assert.equal(result.INDEXING_WORKER_ID, undefined);
  assert.equal(result.SHUTDOWN_TIMEOUT_MS, 10_000);
  assert.equal(result.RATE_LIMIT_WINDOW_MS, 60_000);
  assert.equal(result.RATE_LIMIT_MAX_REQUESTS, 100);
  assert.equal(result.REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(result.AI_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(result.EMBEDDING_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(result.DATABASE_REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(result.REPOSITORY_CLONE_TIMEOUT_MS, 120_000);
});

test("timeout configuration is bounded", () => {
  const result = validateEnv({
    ...REQUIRED,
    REQUEST_TIMEOUT_MS: "1000",
    AI_REQUEST_TIMEOUT_MS: "120000",
    EMBEDDING_REQUEST_TIMEOUT_MS: "5000",
    DATABASE_REQUEST_TIMEOUT_MS: "500",
    REPOSITORY_CLONE_TIMEOUT_MS: "600000",
  });
  assert.equal(result.REQUEST_TIMEOUT_MS, 1_000);
  assert.equal(result.DATABASE_REQUEST_TIMEOUT_MS, 500);
  assert.equal(result.REPOSITORY_CLONE_TIMEOUT_MS, 600_000);
  assert.throws(() => validateEnv({ ...REQUIRED, REQUEST_TIMEOUT_MS: "999" }));
  assert.throws(() => validateEnv({ ...REQUIRED, DATABASE_REQUEST_TIMEOUT_MS: "60001" }));
  assert.throws(() => validateEnv({ ...REQUIRED, REPOSITORY_CLONE_TIMEOUT_MS: "4000" }));
});

test("rate limit configuration accepts positive integers", () => {
  const result = validateEnv({
    ...REQUIRED,
    RATE_LIMIT_WINDOW_MS: "1500",
    RATE_LIMIT_MAX_REQUESTS: "25",
  });

  assert.equal(result.RATE_LIMIT_WINDOW_MS, 1500);
  assert.equal(result.RATE_LIMIT_MAX_REQUESTS, 25);
  assert.throws(() => validateEnv({ ...REQUIRED, RATE_LIMIT_WINDOW_MS: "0" }));
  assert.throws(() => validateEnv({ ...REQUIRED, RATE_LIMIT_MAX_REQUESTS: "1.5" }));
});

test("shutdown timeout is bounded", () => {
  assert.equal(
    validateEnv({ ...REQUIRED, SHUTDOWN_TIMEOUT_MS: "1000" })
      .SHUTDOWN_TIMEOUT_MS,
    1000,
  );
  assert.equal(
    validateEnv({ ...REQUIRED, SHUTDOWN_TIMEOUT_MS: "60000" })
      .SHUTDOWN_TIMEOUT_MS,
    60000,
  );
  assert.throws(() => validateEnv({ ...REQUIRED, SHUTDOWN_TIMEOUT_MS: "999" }));
  assert.throws(() => validateEnv({ ...REQUIRED, SHUTDOWN_TIMEOUT_MS: "60001" }));
});

test("anon key remains a valid fallback when service role is absent", () => {
  const result = validateEnv({
    SUPABASE_URL: REQUIRED.SUPABASE_URL,
    SUPABASE_ANON_KEY: "anon-key",
    OPENAI_API_KEY: REQUIRED.OPENAI_API_KEY,
  });

  assert.equal(result.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(result.SUPABASE_ANON_KEY, "anon-key");
});

test("startup validation runs when the configuration module loads", () => {
  assert.equal(Object.isFrozen(env), true);

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--eval", 'await import("./src/config/env.ts")'],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "invalid-startup-environment" },
    },
  );

  assert.equal(result.status, 1);
  assert.equal(
    result.stderr.trim(),
    "Invalid environment configuration: NODE_ENV.",
  );
  assert.equal(result.stderr.includes("SUPABASE_SERVICE_ROLE_KEY="), false);
  assert.equal(result.stderr.includes("OPENAI_API_KEY="), false);
});
