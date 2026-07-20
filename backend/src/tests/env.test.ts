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
  REPOSITORY_STORAGE_ROOT: "/tmp/giro-repositories-test",
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
  assert.equal(result.REPOSITORY_STORAGE_ROOT, "/tmp/giro-repositories-test");
  assert.equal(result.RETRIEVAL_CACHE_TTL_MS, 60_000);
  assert.equal(result.RETRIEVAL_CACHE_MAX_ENTRIES, 500);
  assert.equal(result.RETRIEVAL_STITCH_LINE_GAP, 0);
  assert.equal(result.QUERY_EXPANSION_MAX_TERMS, 8);
  assert.equal(result.QUERY_EXPANSION_SCORE_PENALTY, 0.85);
  assert.equal(result.RANK_SEMANTIC_WEIGHT, 0.35);
  assert.equal(result.RANK_KEYWORD_WEIGHT, 0.18);
  assert.equal(result.RANK_SYMBOL_WEIGHT, 0.15);
  assert.equal(result.RANK_GRAPH_WEIGHT, 0.08);
  assert.equal(result.RANK_SUMMARY_WEIGHT, 0.07);
  assert.equal(result.RANK_ENTRYPOINT_WEIGHT, 0.06);
  assert.equal(result.RANK_STITCH_BONUS, 0.04);
  assert.equal(result.RANK_DIVERSITY_BONUS, 0.04);
  assert.equal(result.RANK_DUPLICATE_PENALTY, 0.08);
  assert.equal(result.RETRIEVAL_CONFIDENCE_HIGH_THRESHOLD, 0.8);
  assert.equal(result.RETRIEVAL_CONFIDENCE_MEDIUM_THRESHOLD, 0.6);
  assert.equal(result.RETRIEVAL_CONFIDENCE_LOW_THRESHOLD, 0.35);
  assert.equal(result.RETRIEVAL_MIN_CITATION_COVERAGE, 0.5);
  assert.equal(result.RETRIEVAL_MIN_ANSWERABLE_SCORE, 0.35);
  assert.equal(Object.isFrozen(result), true);
});

test("production has no relative, empty, or filesystem-root repository storage fallback", () => {
  for (const value of [undefined, "", ".storage/repos", "/"]) {
    const input = { ...REQUIRED, NODE_ENV: "production" } as Record<string, unknown>;
    if (value === undefined) delete input.REPOSITORY_STORAGE_ROOT;
    else input.REPOSITORY_STORAGE_ROOT = value;
    assert.throws(() => validateEnv(input), (error: unknown) => {
      assert.ok(error instanceof EnvironmentValidationError);
      assert.equal(Object.keys(error.issues).includes("REPOSITORY_STORAGE_ROOT"), true);
      return true;
    });
  }
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
  const result = validateEnv({ ...REQUIRED, REPOSITORY_STORAGE_ROOT: undefined });

  assert.equal(result.NODE_ENV, "development");
  assert.equal(result.PORT, 8000);
  assert.deepEqual(result.CORS_ORIGINS, ["http://localhost:3000"]);
  assert.equal(result.LOG_LEVEL, "info");
  assert.equal(result.JWT_SECRET, "dev-insecure-secret-change-me");
  assert.equal(result.EMBEDDINGS_PROVIDER, "mock");
  assert.equal(result.MODEL_NAME, "gpt-4.1-mini");
  assert.equal(result.REPOSITORY_STORAGE_ROOT, ".storage/repos");
  assert.equal(result.INDEXING_WORKER_ID, undefined);
  assert.equal(result.INDEXING_WORKER_POLL_INTERVAL_MS, 1_000);
  assert.equal(result.INDEXING_WORKER_MAX_POLL_INTERVAL_MS, 10_000);
  assert.equal(result.INDEXING_WORKER_STALE_CLAIM_MS, 300_000);
  assert.equal(result.INDEXING_WORKER_MAX_ATTEMPTS, 3);
  assert.equal(result.INDEXING_WORKER_SHUTDOWN_TIMEOUT_MS, 30_000);
  assert.equal(result.SHUTDOWN_TIMEOUT_MS, 10_000);
  assert.equal(result.RATE_LIMIT_WINDOW_MS, 60_000);
  assert.equal(result.RATE_LIMIT_MAX_REQUESTS, 100);
  assert.equal(result.REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(result.AI_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(result.EMBEDDING_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(result.DATABASE_REQUEST_TIMEOUT_MS, 10_000);
  assert.equal(result.REPOSITORY_CLONE_TIMEOUT_MS, 120_000);
  assert.equal(result.AI_MAX_RETRIES, 2);
  assert.equal(result.EMBEDDING_MAX_RETRIES, 2);
  assert.equal(result.DATABASE_MAX_RETRIES, 2);
  assert.equal(result.CLONE_MAX_RETRIES, 1);
  assert.equal(result.AI_RETRY_BASE_MS, 200);
  assert.equal(result.EMBEDDING_RETRY_BASE_MS, 200);
  assert.equal(result.DATABASE_RETRY_BASE_MS, 100);
  assert.equal(result.CLONE_RETRY_BASE_MS, 500);
  assert.equal(result.AI_CIRCUIT_MIN_SAMPLES, 5);
  assert.equal(result.AI_CIRCUIT_FAILURE_THRESHOLD, 5);
  assert.equal(result.AI_CIRCUIT_WINDOW_MS, 60_000);
  assert.equal(result.AI_CIRCUIT_OPEN_MS, 30_000);
  assert.equal(result.EMBEDDING_CIRCUIT_MIN_SAMPLES, 5);
  assert.equal(result.EMBEDDING_CIRCUIT_FAILURE_THRESHOLD, 5);
  assert.equal(result.DATABASE_CIRCUIT_MIN_SAMPLES, 5);
  assert.equal(result.DATABASE_CIRCUIT_FAILURE_THRESHOLD, 5);
  assert.equal(result.DATABASE_CIRCUIT_OPEN_MS, 15_000);
  assert.equal(result.CLONE_CIRCUIT_MIN_SAMPLES, 3);
  assert.equal(result.CLONE_CIRCUIT_FAILURE_THRESHOLD, 3);
  assert.equal(result.CIRCUIT_HALF_OPEN_MAX_CALLS, 1);
});

test("continuous worker configuration rejects unsafe relationships", () => {
  assert.throws(() => validateEnv({
    ...REQUIRED,
    INDEXING_WORKER_POLL_INTERVAL_MS: "2000",
    INDEXING_WORKER_MAX_POLL_INTERVAL_MS: "1000",
  }));
  assert.throws(() => validateEnv({
    ...REQUIRED,
    INDEXING_WORKER_HEARTBEAT_MS: "10000",
    INDEXING_WORKER_STALE_CLAIM_MS: "10000",
  }));
  assert.throws(() => validateEnv({
    ...REQUIRED,
    INDEXING_WORKER_RETRY_BASE_MS: "10000",
    INDEXING_WORKER_RETRY_MAX_MS: "5000",
  }));
  assert.throws(() => validateEnv({
    ...REQUIRED,
    INDEXING_WORKER_MAX_ATTEMPTS: "11",
  }));
});

test("circuit configuration validates thresholds and bounds", () => {
  const result = validateEnv({
    ...REQUIRED,
    AI_CIRCUIT_MIN_SAMPLES: "10",
    AI_CIRCUIT_FAILURE_THRESHOLD: "4",
    AI_CIRCUIT_WINDOW_MS: "1000",
    AI_CIRCUIT_OPEN_MS: "100",
    CIRCUIT_HALF_OPEN_MAX_CALLS: "2",
  });
  assert.equal(result.AI_CIRCUIT_MIN_SAMPLES, 10);
  assert.equal(result.AI_CIRCUIT_FAILURE_THRESHOLD, 4);
  assert.equal(result.CIRCUIT_HALF_OPEN_MAX_CALLS, 2);
  assert.throws(() => validateEnv({
    ...REQUIRED,
    AI_CIRCUIT_MIN_SAMPLES: "2",
    AI_CIRCUIT_FAILURE_THRESHOLD: "3",
  }));
  assert.throws(() => validateEnv({ ...REQUIRED, DATABASE_CIRCUIT_WINDOW_MS: "999" }));
  assert.throws(() => validateEnv({ ...REQUIRED, CIRCUIT_HALF_OPEN_MAX_CALLS: "11" }));
});

test("retry configuration supports disabling and enforces safe bounds", () => {
  const result = validateEnv({
    ...REQUIRED,
    AI_MAX_RETRIES: "0",
    EMBEDDING_MAX_RETRIES: "5",
    DATABASE_MAX_RETRIES: "1",
    CLONE_MAX_RETRIES: "3",
    AI_RETRY_BASE_MS: "10",
    EMBEDDING_RETRY_BASE_MS: "10000",
    DATABASE_RETRY_BASE_MS: "50",
    CLONE_RETRY_BASE_MS: "1000",
  });
  assert.equal(result.AI_MAX_RETRIES, 0);
  assert.equal(result.EMBEDDING_MAX_RETRIES, 5);
  assert.equal(result.CLONE_MAX_RETRIES, 3);
  assert.equal(result.AI_RETRY_BASE_MS, 10);
  assert.throws(() => validateEnv({ ...REQUIRED, AI_MAX_RETRIES: "6" }));
  assert.throws(() => validateEnv({ ...REQUIRED, CLONE_MAX_RETRIES: "4" }));
  assert.throws(() => validateEnv({ ...REQUIRED, DATABASE_RETRY_BASE_MS: "9" }));
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
    RATE_LIMIT_AUTH_MAX_REQUESTS: "5",
    RATE_LIMIT_REPOSITORY_CONNECT_MAX_REQUESTS: "6",
    RATE_LIMIT_ASK_GIRO_MAX_REQUESTS: "7",
    RATE_LIMIT_RETRIEVAL_SEARCH_MAX_REQUESTS: "8",
    RATE_LIMIT_INDEXING_MAX_REQUESTS: "9",
  });

  assert.equal(result.RATE_LIMIT_WINDOW_MS, 1500);
  assert.equal(result.RATE_LIMIT_MAX_REQUESTS, 25);
  assert.equal(result.RATE_LIMIT_AUTH_MAX_REQUESTS, 5);
  assert.equal(result.RATE_LIMIT_REPOSITORY_CONNECT_MAX_REQUESTS, 6);
  assert.equal(result.RATE_LIMIT_ASK_GIRO_MAX_REQUESTS, 7);
  assert.equal(result.RATE_LIMIT_RETRIEVAL_SEARCH_MAX_REQUESTS, 8);
  assert.equal(result.RATE_LIMIT_INDEXING_MAX_REQUESTS, 9);
  assert.throws(() => validateEnv({ ...REQUIRED, RATE_LIMIT_WINDOW_MS: "0" }));
  assert.throws(() => validateEnv({ ...REQUIRED, RATE_LIMIT_MAX_REQUESTS: "1.5" }));
  assert.throws(() => validateEnv({ ...REQUIRED, RATE_LIMIT_AUTH_MAX_REQUESTS: "0" }));
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

test("retrieval cache configuration is bounded", () => {
  const result = validateEnv({
    ...REQUIRED,
    RETRIEVAL_CACHE_TTL_MS: "1000",
    RETRIEVAL_CACHE_MAX_ENTRIES: "10000",
  });
  assert.equal(result.RETRIEVAL_CACHE_TTL_MS, 1_000);
  assert.equal(result.RETRIEVAL_CACHE_MAX_ENTRIES, 10_000);
  assert.throws(() => validateEnv({ ...REQUIRED, RETRIEVAL_CACHE_TTL_MS: "999" }));
  assert.throws(() => validateEnv({ ...REQUIRED, RETRIEVAL_CACHE_TTL_MS: "3600001" }));
  assert.throws(() => validateEnv({ ...REQUIRED, RETRIEVAL_CACHE_MAX_ENTRIES: "0" }));
  assert.throws(() => validateEnv({ ...REQUIRED, RETRIEVAL_CACHE_MAX_ENTRIES: "10001" }));
});

test("adjacent chunk line-gap configuration is bounded", () => {
  assert.equal(validateEnv({ ...REQUIRED, RETRIEVAL_STITCH_LINE_GAP: "8" }).RETRIEVAL_STITCH_LINE_GAP, 8);
  assert.throws(() => validateEnv({ ...REQUIRED, RETRIEVAL_STITCH_LINE_GAP: "-1" }));
  assert.throws(() => validateEnv({ ...REQUIRED, RETRIEVAL_STITCH_LINE_GAP: "1001" }));
});

test("query expansion configuration is bounded", () => {
  const result = validateEnv({
    ...REQUIRED,
    QUERY_EXPANSION_MAX_TERMS: "12",
    QUERY_EXPANSION_SCORE_PENALTY: "0.7",
  });
  assert.equal(result.QUERY_EXPANSION_MAX_TERMS, 12);
  assert.equal(result.QUERY_EXPANSION_SCORE_PENALTY, 0.7);
  assert.throws(() => validateEnv({ ...REQUIRED, QUERY_EXPANSION_MAX_TERMS: "51" }));
  assert.throws(() => validateEnv({ ...REQUIRED, QUERY_EXPANSION_SCORE_PENALTY: "0.09" }));
  assert.throws(() => validateEnv({ ...REQUIRED, QUERY_EXPANSION_SCORE_PENALTY: "1.01" }));
});

test("weighted ranking configuration is bounded", () => {
  const result = validateEnv({
    ...REQUIRED,
    RANK_SEMANTIC_WEIGHT: "0",
    RANK_KEYWORD_WEIGHT: "1",
    RANK_DUPLICATE_PENALTY: "0.25",
  });
  assert.equal(result.RANK_SEMANTIC_WEIGHT, 0);
  assert.equal(result.RANK_KEYWORD_WEIGHT, 1);
  assert.equal(result.RANK_DUPLICATE_PENALTY, 0.25);
  assert.throws(() => validateEnv({ ...REQUIRED, RANK_GRAPH_WEIGHT: "-0.01" }));
  assert.throws(() => validateEnv({ ...REQUIRED, RANK_STITCH_BONUS: "1.01" }));
});

test("retrieval confidence configuration is bounded and ordered", () => {
  const result = validateEnv({
    ...REQUIRED,
    RETRIEVAL_CONFIDENCE_HIGH_THRESHOLD: "0.9",
    RETRIEVAL_CONFIDENCE_MEDIUM_THRESHOLD: "0.7",
    RETRIEVAL_CONFIDENCE_LOW_THRESHOLD: "0.4",
    RETRIEVAL_MIN_CITATION_COVERAGE: "0.6",
    RETRIEVAL_MIN_ANSWERABLE_SCORE: "0.4",
  });
  assert.equal(result.RETRIEVAL_CONFIDENCE_HIGH_THRESHOLD, 0.9);
  assert.equal(result.RETRIEVAL_CONFIDENCE_MEDIUM_THRESHOLD, 0.7);
  assert.equal(result.RETRIEVAL_CONFIDENCE_LOW_THRESHOLD, 0.4);
  assert.equal(result.RETRIEVAL_MIN_CITATION_COVERAGE, 0.6);
  assert.equal(result.RETRIEVAL_MIN_ANSWERABLE_SCORE, 0.4);
  assert.throws(() => validateEnv({
    ...REQUIRED,
    RETRIEVAL_CONFIDENCE_HIGH_THRESHOLD: "0.5",
    RETRIEVAL_CONFIDENCE_MEDIUM_THRESHOLD: "0.6",
  }));
  assert.throws(() => validateEnv({
    ...REQUIRED,
    RETRIEVAL_MIN_CITATION_COVERAGE: "1.01",
  }));
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
  const startupLog = JSON.parse(result.stderr.trim()) as Record<string, unknown>;
  assert.equal(startupLog.level, "error");
  assert.equal(startupLog.operation, "environment_validation_failed");
  assert.equal(startupLog.errorMessage, "Invalid environment configuration: NODE_ENV.");
  assert.equal(typeof startupLog.timestamp, "string");
  assert.equal(result.stderr.includes("SUPABASE_SERVICE_ROLE_KEY="), false);
  assert.equal(result.stderr.includes("OPENAI_API_KEY="), false);
});
