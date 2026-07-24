// Loads and validates all runtime environment variables once at process startup.

import "dotenv/config";
import path from "node:path";
import { z } from "zod";
import { stderrLogger } from "../lib/logger.js";
import { validateTrustedProxyCidrs } from "../middleware/trustedProxy.js";

const DEVELOPMENT_JWT_SECRET = "dev-insecure-secret-change-me";
const DEVELOPMENT_JWT_KEY_ID = "development-key";
const JWT_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function integerEnvironmentValue(
  defaultValue: number,
  minimum: number,
  maximum: number,
) {
  return z.coerce.number().int().min(minimum).max(maximum).default(defaultValue);
}

function durationEnvironmentValue(
  defaultValue: number,
  minimum: number,
  maximum: number,
) {
  return integerEnvironmentValue(defaultValue, minimum, maximum);
}

function optionalDurationEnvironmentValue(minimum: number, maximum: number) {
  return z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.coerce.number().int().min(minimum).max(maximum).optional(),
  );
}

function booleanEnvironmentValue(defaultValue: boolean) {
  return z
    .enum(["true", "false"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true");
}

function nonNegativeIntegerEnvironmentValue(defaultValue: number, maximum: number) {
  return z.coerce.number().int().min(0).max(maximum).default(defaultValue);
}

const httpUrlEnvironmentValue = z.string().trim().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "URL must use HTTP or HTTPS.");

const repositoryStorageEnvironmentValue = z.string().trim().min(1).refine(
  (value) => !value.includes("\0"),
  "Repository storage root is invalid.",
);

const optionalNonEmptyString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const jwtVerificationKeysEnvironmentValue = z
  .string()
  .default("{}")
  .transform((value, context): Readonly<Record<string, string>> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      context.addIssue({ code: "custom", message: "Verification keys must be a JSON object." });
      return z.NEVER;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      context.addIssue({ code: "custom", message: "Verification keys must be a JSON object." });
      return z.NEVER;
    }
    const keys: Record<string, string> = {};
    for (const [keyId, secret] of Object.entries(parsed)) {
      if (!JWT_KEY_ID_PATTERN.test(keyId)) {
        context.addIssue({ code: "custom", message: "Verification key IDs are invalid." });
        return z.NEVER;
      }
      if (typeof secret !== "string" || secret.length < 16) {
        context.addIssue({ code: "custom", message: "Verification keys must contain sufficiently strong secrets." });
        return z.NEVER;
      }
      keys[keyId] = secret;
    }
    return Object.freeze(keys);
  });

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: integerEnvironmentValue(8000, 1, 65_535),
    CORS_ORIGINS: z
      .string()
      .default("http://localhost:3000")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(httpUrlEnvironmentValue).min(1)),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    JWT_SECRET: z.string().min(16).default(DEVELOPMENT_JWT_SECRET),
    JWT_ISSUER: z.string().trim().min(1).max(256).default("giro-backend"),
    JWT_AUDIENCE: z.string().trim().min(1).max(256).default("giro-api"),
    JWT_ACCESS_TOKEN_TTL_SECONDS: integerEnvironmentValue(900, 60, 3_600),
    JWT_CLOCK_SKEW_SECONDS: integerEnvironmentValue(30, 0, 300),
    JWT_ACTIVE_KEY_ID: z.string().trim().regex(JWT_KEY_ID_PATTERN).default(DEVELOPMENT_JWT_KEY_ID),
    JWT_VERIFICATION_KEYS: jwtVerificationKeysEnvironmentValue,
    SUPABASE_URL: httpUrlEnvironmentValue,
    SUPABASE_ANON_KEY: optionalNonEmptyString,
    SUPABASE_SERVICE_ROLE_KEY: optionalNonEmptyString,
    OPENAI_API_KEY: z.string().trim().min(20),
    EMBEDDINGS_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
    MODEL_NAME: z.string().trim().min(1).default("gpt-4.1-mini"),
    REPOSITORY_STORAGE_ROOT: repositoryStorageEnvironmentValue.default(".storage/repos"),
    INDEXING_WORKER_ENABLED: booleanEnvironmentValue(false),
    INDEXING_WORKER_ID: optionalNonEmptyString,
    INDEXING_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    INDEXING_WORKER_IDLE_BACKOFF_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    INDEXING_WORKER_MAX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(300_000).default(10_000),
    INDEXING_WORKER_STALE_CLAIM_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(300_000),
    INDEXING_WORKER_HEARTBEAT_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),
    INDEXING_WORKER_RETRY_BASE_MS: z.coerce.number().int().min(100).max(300_000).default(5_000),
    INDEXING_WORKER_RETRY_MAX_MS: z.coerce.number().int().min(100).max(3_600_000).default(300_000),
    INDEXING_WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    INDEXING_WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
    INDEXING_WORKER_MAX_CONSECUTIVE_DATABASE_FAILURES: z.coerce.number().int().min(1).max(100).default(3),
    INDEXING_WORKER_STALL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    RETRIEVAL_CACHE_TTL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    RETRIEVAL_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(10_000).default(500),
    REPOSITORY_ARTIFACT_RETENTION_COUNT: z.coerce.number().int().min(1).max(100).default(3),
    REPOSITORY_CHECKOUT_RETENTION_COUNT: z.coerce.number().int().min(1).max(100).default(3),
    REPOSITORY_QUOTA_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(1_099_511_627_776).default(1_073_741_824),
    REPOSITORY_QUOTA_MAX_FILES: z.coerce.number().int().min(1).max(10_000_000).default(100_000),
    REPOSITORY_QUOTA_MAX_DIRECTORY_DEPTH: z.coerce.number().int().min(1).max(1_024).default(64),
    REPOSITORY_QUOTA_MAX_FILE_BYTES: z.coerce.number().int().min(1).max(1_073_741_824).default(5_242_880),
    REPOSITORY_QUOTA_MAX_SYMLINKS: z.coerce.number().int().min(0).max(1_000_000).default(1_000),
    REPOSITORY_QUOTA_MAX_BINARY_FILES: z.coerce.number().int().min(0).max(10_000_000).default(10_000),
    REPOSITORY_QUOTA_MAX_INDEXED_TEXT_BYTES: z.coerce.number().int().min(1).max(1_099_511_627_776).default(268_435_456),
    REPOSITORY_QUOTA_MAX_ARTIFACT_BYTES: z.coerce.number().int().min(1_024).max(1_073_741_824).default(67_108_864),
    REPOSITORY_QUOTA_MAX_INDEXING_DURATION_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(1_800_000),
    REPOSITORY_QUOTA_MAX_CONCURRENT_PER_USER: z.coerce.number().int().min(1).max(1_000).default(2),
    REPOSITORY_QUOTA_MAX_REPOSITORIES_PER_USER: z.coerce.number().int().min(1).max(1_000_000).default(100),
    REPOSITORY_QUOTA_MAX_STORAGE_PER_USER_BYTES: z.coerce.number().int().min(1_048_576).max(9_007_199_254_740_991).default(10_737_418_240),
    REPOSITORY_GRAPH_MAX_NODES: z.coerce.number().int().min(1).max(10_000_000).default(500_000),
    REPOSITORY_GRAPH_MAX_EDGES: z.coerce.number().int().min(1).max(50_000_000).default(2_000_000),
    REPOSITORY_GRAPH_MAX_DURATION_MS: z.coerce.number().int().min(100).max(86_400_000).default(600_000),
    REPOSITORY_GRAPH_MAX_BYTES: z.coerce.number().int().min(1_024).max(1_073_741_824).default(134_217_728),
    REPOSITORY_GRAPH_MAX_UNRESOLVED_RATIO: z.coerce.number().min(0).max(1).default(0.75),
    REPOSITORY_GRAPH_MAX_PARSER_FAILURE_RATIO: z.coerce.number().min(0).max(1).default(0.25),
    REPOSITORY_GRAPH_RETENTION_COUNT: z.coerce.number().int().min(1).max(100).default(3),
    REPOSITORY_INTELLIGENCE_MAX_BYTES: z.coerce.number().int().min(1_024).max(1_073_741_824).default(67_108_864),
    REPOSITORY_INTELLIGENCE_MAX_DURATION_MS: z.coerce.number().int().min(100).max(86_400_000).default(600_000),
    REPOSITORY_INTELLIGENCE_RETENTION_COUNT: z.coerce.number().int().min(2).max(100).default(3),
    REPOSITORY_PLAN_MAX_DURATION_MS: z.coerce.number().int().min(10).max(86_400_000).default(120_000),
    REPOSITORY_PLAN_RETENTION_COUNT: z.coerce.number().int().min(2).max(100).default(10),
    EXECUTION_MAX_ACTIVE_RUNS_PER_USER: z.coerce.number().int().min(1).max(1_000).default(10),
    EXECUTION_MAX_WORK_UNITS_PER_RUN: z.coerce.number().int().min(1).max(10_000).default(250),
    EXECUTION_MAX_CONCURRENT_LEASES_PER_USER: z.coerce.number().int().min(1).max(1_000).default(10),
    EXECUTION_MAX_ATTEMPTS_PER_WORK_UNIT: z.coerce.number().int().min(1).max(20).default(3),
    EXECUTION_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1_024).max(1_073_741_824).default(1_048_576),
    EXECUTION_MAX_DURATION_MS: z.coerce.number().int().min(1_000).max(604_800_000).default(86_400_000),
    EXECUTION_RETAINED_RUNS: z.coerce.number().int().min(1).max(10_000).default(50),
    EXECUTION_LEASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    GUARDED_EXECUTION_ENABLED: booleanEnvironmentValue(false),
    REPOSITORY_GRAPH_TRAVERSAL_DEPTH: z.coerce.number().int().min(1).max(10).default(2),
    REPOSITORY_GRAPH_MAX_EXPANDED_CANDIDATES: z.coerce.number().int().min(1).max(1_000).default(50),
    RETRIEVAL_GRAPH_DIRECT_WEIGHT: z.coerce.number().min(0).max(1).default(0.25),
    RETRIEVAL_GRAPH_CALL_WEIGHT: z.coerce.number().min(0).max(1).default(0.20),
    RETRIEVAL_GRAPH_IMPORT_WEIGHT: z.coerce.number().min(0).max(1).default(0.12),
    RETRIEVAL_GRAPH_INHERITANCE_WEIGHT: z.coerce.number().min(0).max(1).default(0.12),
    RETRIEVAL_GRAPH_IMPLEMENTATION_WEIGHT: z.coerce.number().min(0).max(1).default(0.12),
    RETRIEVAL_GRAPH_REFERENCE_WEIGHT: z.coerce.number().min(0).max(1).default(0.08),
    RETRIEVAL_GRAPH_CENTRALITY_WEIGHT: z.coerce.number().min(0).max(1).default(0.06),
    RETRIEVAL_GRAPH_DISTANCE_PENALTY: z.coerce.number().min(0).max(1).default(0.05),
    RETRIEVAL_STITCH_LINE_GAP: z.coerce.number().int().min(0).max(1_000).default(0),
    QUERY_EXPANSION_MAX_TERMS: z.coerce.number().int().min(0).max(50).default(8),
    QUERY_EXPANSION_SCORE_PENALTY: z.coerce.number().min(0.1).max(1).default(0.85),
    RANK_SEMANTIC_WEIGHT: z.coerce.number().min(0).max(1).default(0.35),
    RANK_KEYWORD_WEIGHT: z.coerce.number().min(0).max(1).default(0.18),
    RANK_SYMBOL_WEIGHT: z.coerce.number().min(0).max(1).default(0.15),
    RANK_GRAPH_WEIGHT: z.coerce.number().min(0).max(1).default(0.08),
    RANK_SUMMARY_WEIGHT: z.coerce.number().min(0).max(1).default(0.07),
    RANK_ENTRYPOINT_WEIGHT: z.coerce.number().min(0).max(1).default(0.06),
    RANK_STITCH_BONUS: z.coerce.number().min(0).max(1).default(0.04),
    RANK_DIVERSITY_BONUS: z.coerce.number().min(0).max(1).default(0.04),
    RANK_DUPLICATE_PENALTY: z.coerce.number().min(0).max(1).default(0.08),
    RETRIEVAL_V2_SEMANTIC_WEIGHT: z.coerce.number().min(0).max(1).default(0.30),
    RETRIEVAL_V2_LEXICAL_WEIGHT: z.coerce.number().min(0).max(1).default(0.18),
    RETRIEVAL_V2_SYMBOL_WEIGHT: z.coerce.number().min(0).max(1).default(0.12),
    RETRIEVAL_V2_PATH_WEIGHT: z.coerce.number().min(0).max(1).default(0.08),
    RETRIEVAL_V2_FILE_IMPORTANCE_WEIGHT: z.coerce.number().min(0).max(1).default(0.08),
    RETRIEVAL_V2_REPOSITORY_IMPORTANCE_WEIGHT: z.coerce.number().min(0).max(1).default(0.06),
    RETRIEVAL_V2_DEPENDENCY_IMPORTANCE_WEIGHT: z.coerce.number().min(0).max(1).default(0.08),
    RETRIEVAL_V2_FRESHNESS_WEIGHT: z.coerce.number().min(0).max(1).default(0.04),
    RETRIEVAL_V2_REVISION_MATCH_WEIGHT: z.coerce.number().min(0).max(1).default(0.06),
    RETRIEVAL_V2_MAX_CHUNKS: z.coerce.number().int().min(1).max(100).default(20),
    RETRIEVAL_V2_MAX_FILES: z.coerce.number().int().min(1).max(100).default(12),
    RETRIEVAL_V2_MAX_SYMBOLS: z.coerce.number().int().min(1).max(100).default(12),
    RETRIEVAL_V2_MAX_TOKENS: z.coerce.number().int().min(1).max(1_000_000).default(8_000),
    RETRIEVAL_V2_MAX_PER_FILE: z.coerce.number().int().min(1).max(20).default(2),
    RETRIEVAL_RERANKER_PROVIDER: z.enum(["deterministic", "openai"]).default("deterministic"),
    RETRIEVAL_RERANKER_MODEL: z.string().trim().min(1).default("gpt-4.1-mini"),
    RETRIEVAL_RERANKER_WEIGHT: z.coerce.number().min(0).max(1).default(0.25),
    RETRIEVAL_CONFIDENCE_HIGH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.80),
    RETRIEVAL_CONFIDENCE_MEDIUM_THRESHOLD: z.coerce.number().min(0).max(1).default(0.60),
    RETRIEVAL_CONFIDENCE_LOW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
    RETRIEVAL_MIN_CITATION_COVERAGE: z.coerce.number().min(0).max(1).default(0.50),
    RETRIEVAL_MIN_ANSWERABLE_SCORE: z.coerce.number().min(0).max(1).default(0.35),
    SHUTDOWN_TIMEOUT_MS: durationEnvironmentValue(10_000, 1_000, 60_000),
    RATE_LIMIT_WINDOW_MS: durationEnvironmentValue(60_000, 1_000, 3_600_000),
    RATE_LIMIT_BACKEND: z.enum(["memory", "supabase"]).optional(),
    TRUSTED_PROXY_CIDRS: z.string().default("").transform((value, context) => {
      const cidrs = value.split(",").map((entry) => entry.trim()).filter(Boolean);
      try {
        validateTrustedProxyCidrs(cidrs);
      } catch {
        context.addIssue({ code: "custom", message: "Trusted proxy CIDRs are invalid." });
        return z.NEVER;
      }
      return Object.freeze(cidrs);
    }),
    RATE_LIMIT_MAX_REQUESTS: integerEnvironmentValue(100, 1, 1_000_000),
    RATE_LIMIT_DEFAULT_BURST: nonNegativeIntegerEnvironmentValue(0, 1_000_000),
    RATE_LIMIT_DEFAULT_WINDOW_MS: optionalDurationEnvironmentValue(1_000, 3_600_000),
    RATE_LIMIT_AUTH_MAX_REQUESTS: integerEnvironmentValue(20, 1, 1_000_000),
    RATE_LIMIT_AUTH_BURST: nonNegativeIntegerEnvironmentValue(0, 1_000_000),
    RATE_LIMIT_AUTH_WINDOW_MS: optionalDurationEnvironmentValue(1_000, 3_600_000),
    RATE_LIMIT_REPOSITORY_CONNECT_MAX_REQUESTS: integerEnvironmentValue(10, 1, 1_000_000),
    RATE_LIMIT_REPOSITORY_CONNECT_BURST: nonNegativeIntegerEnvironmentValue(0, 1_000_000),
    RATE_LIMIT_REPOSITORY_CONNECT_WINDOW_MS: optionalDurationEnvironmentValue(1_000, 3_600_000),
    RATE_LIMIT_ASK_GIRO_MAX_REQUESTS: integerEnvironmentValue(20, 1, 1_000_000),
    RATE_LIMIT_ASK_GIRO_BURST: nonNegativeIntegerEnvironmentValue(0, 1_000_000),
    RATE_LIMIT_ASK_GIRO_WINDOW_MS: optionalDurationEnvironmentValue(1_000, 3_600_000),
    RATE_LIMIT_RETRIEVAL_SEARCH_MAX_REQUESTS: integerEnvironmentValue(60, 1, 1_000_000),
    RATE_LIMIT_RETRIEVAL_SEARCH_BURST: nonNegativeIntegerEnvironmentValue(0, 1_000_000),
    RATE_LIMIT_RETRIEVAL_SEARCH_WINDOW_MS: optionalDurationEnvironmentValue(1_000, 3_600_000),
    RATE_LIMIT_INDEXING_MAX_REQUESTS: integerEnvironmentValue(30, 1, 1_000_000),
    RATE_LIMIT_INDEXING_BURST: nonNegativeIntegerEnvironmentValue(0, 1_000_000),
    RATE_LIMIT_INDEXING_WINDOW_MS: optionalDurationEnvironmentValue(1_000, 3_600_000),
    REQUEST_TIMEOUT_MS: durationEnvironmentValue(30_000, 1_000, 120_000),
    AI_REQUEST_TIMEOUT_MS: durationEnvironmentValue(30_000, 1_000, 120_000),
    EMBEDDING_REQUEST_TIMEOUT_MS: durationEnvironmentValue(30_000, 1_000, 120_000),
    DATABASE_REQUEST_TIMEOUT_MS: durationEnvironmentValue(10_000, 500, 60_000),
    DATABASE_STATEMENT_TIMEOUT_MS: durationEnvironmentValue(15_000, 500, 120_000),
    REPOSITORY_CONNECTION_IDEMPOTENCY_RETENTION_MS: durationEnvironmentValue(86_400_000, 60_000, 2_592_000_000),
    SESSION_LIST_DEFAULT_PAGE_SIZE: integerEnvironmentValue(50, 1, 500),
    SESSION_LIST_MAX_PAGE_SIZE: integerEnvironmentValue(200, 1, 1_000),
    SESSION_TURN_IDEMPOTENCY_RETENTION_MS: durationEnvironmentValue(86_400_000, 60_000, 2_592_000_000),
    REPOSITORY_HISTORY_DEFAULT_PAGE_SIZE: integerEnvironmentValue(100, 1, 500),
    REPOSITORY_HISTORY_MAX_PAGE_SIZE: integerEnvironmentValue(500, 1, 1_000),
    REPOSITORY_HISTORY_MAX_RECORDS_PER_TYPE: integerEnvironmentValue(500, 1, 10_000),
    REPOSITORY_HISTORY_MAX_AGE_MS: durationEnvironmentValue(7_776_000_000, 86_400_000, 31_536_000_000),
    REPOSITORY_CLONE_TIMEOUT_MS: durationEnvironmentValue(120_000, 5_000, 600_000),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    EMBEDDING_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    DATABASE_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    CLONE_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),
    AI_RETRY_BASE_MS: z.coerce.number().int().min(10).max(10_000).default(200),
    EMBEDDING_RETRY_BASE_MS: z.coerce.number().int().min(10).max(10_000).default(200),
    DATABASE_RETRY_BASE_MS: z.coerce.number().int().min(10).max(10_000).default(100),
    CLONE_RETRY_BASE_MS: z.coerce.number().int().min(10).max(10_000).default(500),
    AI_CIRCUIT_MIN_SAMPLES: z.coerce.number().int().min(1).max(100).default(5),
    AI_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
    AI_CIRCUIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    AI_CIRCUIT_OPEN_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
    EMBEDDING_CIRCUIT_MIN_SAMPLES: z.coerce.number().int().min(1).max(100).default(5),
    EMBEDDING_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
    EMBEDDING_CIRCUIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    EMBEDDING_CIRCUIT_OPEN_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
    DATABASE_CIRCUIT_MIN_SAMPLES: z.coerce.number().int().min(1).max(100).default(5),
    DATABASE_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
    DATABASE_CIRCUIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    DATABASE_CIRCUIT_OPEN_MS: z.coerce.number().int().min(100).max(600_000).default(15_000),
    CLONE_CIRCUIT_MIN_SAMPLES: z.coerce.number().int().min(1).max(100).default(3),
    CLONE_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(3),
    CLONE_CIRCUIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    CLONE_CIRCUIT_OPEN_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
    CIRCUIT_HALF_OPEN_MAX_CALLS: z.coerce.number().int().min(1).max(10).default(1),
  })
  .superRefine((value, context) => {
    if (value.INDEXING_WORKER_POLL_INTERVAL_MS > value.INDEXING_WORKER_MAX_POLL_INTERVAL_MS) {
      context.addIssue({ code: "custom", path: ["INDEXING_WORKER_MAX_POLL_INTERVAL_MS"], message: "Maximum poll interval must be at least the base poll interval." });
    }
    if (value.INDEXING_WORKER_HEARTBEAT_MS >= value.INDEXING_WORKER_STALE_CLAIM_MS) {
      context.addIssue({ code: "custom", path: ["INDEXING_WORKER_HEARTBEAT_MS"], message: "Heartbeat interval must be shorter than the stale claim threshold." });
    }
    if (value.INDEXING_WORKER_RETRY_BASE_MS > value.INDEXING_WORKER_RETRY_MAX_MS) {
      context.addIssue({ code: "custom", path: ["INDEXING_WORKER_RETRY_MAX_MS"], message: "Maximum retry delay must be at least the base retry delay." });
    }
    if (value.INDEXING_WORKER_STALL_TIMEOUT_MS <= value.INDEXING_WORKER_MAX_POLL_INTERVAL_MS) {
      context.addIssue({ code: "custom", path: ["INDEXING_WORKER_STALL_TIMEOUT_MS"], message: "Worker stall timeout must exceed the maximum poll interval." });
    }
    if (value.REPOSITORY_QUOTA_MAX_FILE_BYTES > value.REPOSITORY_QUOTA_MAX_BYTES) {
      context.addIssue({ code: "custom", path: ["REPOSITORY_QUOTA_MAX_FILE_BYTES"], message: "File quota cannot exceed repository quota." });
    }
    if (value.REPOSITORY_QUOTA_MAX_INDEXED_TEXT_BYTES > value.REPOSITORY_QUOTA_MAX_BYTES) {
      context.addIssue({ code: "custom", path: ["REPOSITORY_QUOTA_MAX_INDEXED_TEXT_BYTES"], message: "Indexed text quota cannot exceed repository quota." });
    }
    if (value.SESSION_LIST_DEFAULT_PAGE_SIZE > value.SESSION_LIST_MAX_PAGE_SIZE) {
      context.addIssue({ code: "custom", path: ["SESSION_LIST_DEFAULT_PAGE_SIZE"], message: "Default session page size cannot exceed the maximum." });
    }
    if (value.REPOSITORY_HISTORY_DEFAULT_PAGE_SIZE > value.REPOSITORY_HISTORY_MAX_PAGE_SIZE) {
      context.addIssue({ code: "custom", path: ["REPOSITORY_HISTORY_DEFAULT_PAGE_SIZE"], message: "Default repository history page size cannot exceed the maximum." });
    }
    if (!value.SUPABASE_SERVICE_ROLE_KEY && !value.SUPABASE_ANON_KEY) {
      context.addIssue({
        code: "custom",
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
        message: "A Supabase service-role or anon key is required.",
      });
    }
    if (value.NODE_ENV === "production" && !value.SUPABASE_SERVICE_ROLE_KEY) {
      context.addIssue({
        code: "custom",
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
        message: "The service-role key is required for durable backend persistence in production.",
      });
    }
    if (value.NODE_ENV === "production" && value.RATE_LIMIT_BACKEND === "memory") {
      context.addIssue({
        code: "custom",
        path: ["RATE_LIMIT_BACKEND"],
        message: "Production rate limiting must use the Supabase backend.",
      });
    }
    if (value.NODE_ENV === "production") {
      const repositoryRoot = value.REPOSITORY_STORAGE_ROOT;
      if (!path.isAbsolute(repositoryRoot) || repositoryRoot === ".storage/repos") {
        context.addIssue({
          code: "custom",
          path: ["REPOSITORY_STORAGE_ROOT"],
          message: "Production repository storage root must be an explicit absolute non-root path.",
        });
      }
      if (value.JWT_SECRET === DEVELOPMENT_JWT_SECRET) {
        context.addIssue({
          code: "custom",
          path: ["JWT_SECRET"],
          message: "Production JWT secret must be explicitly configured.",
        });
      }
    }
    const configuredPreviousActiveKey = value.JWT_VERIFICATION_KEYS[value.JWT_ACTIVE_KEY_ID];
    if (
      configuredPreviousActiveKey !== undefined &&
      configuredPreviousActiveKey !== value.JWT_SECRET
    ) {
      context.addIssue({
        code: "custom",
        path: ["JWT_VERIFICATION_KEYS"],
        message: "The active key ID cannot map to different verification material.",
      });
    }
    const resolvedRepositoryRoot = path.resolve(value.REPOSITORY_STORAGE_ROOT);
    if (resolvedRepositoryRoot === path.parse(resolvedRepositoryRoot).root) {
      context.addIssue({
        code: "custom",
        path: ["REPOSITORY_STORAGE_ROOT"],
        message: "Repository storage root cannot be a filesystem root.",
      });
    }
    for (const dependency of ["AI", "EMBEDDING", "DATABASE", "CLONE"] as const) {
      const threshold = value[`${dependency}_CIRCUIT_FAILURE_THRESHOLD`];
      const minimumSamples = value[`${dependency}_CIRCUIT_MIN_SAMPLES`];
      if (threshold > minimumSamples) {
        context.addIssue({
          code: "custom",
          path: [`${dependency}_CIRCUIT_FAILURE_THRESHOLD`],
          message: "Circuit failure threshold must not exceed minimum samples.",
        });
      }
    }
    if (!(
      value.RETRIEVAL_CONFIDENCE_HIGH_THRESHOLD >=
        value.RETRIEVAL_CONFIDENCE_MEDIUM_THRESHOLD &&
      value.RETRIEVAL_CONFIDENCE_MEDIUM_THRESHOLD >=
        value.RETRIEVAL_CONFIDENCE_LOW_THRESHOLD
    )) {
      context.addIssue({
        code: "custom",
        path: ["RETRIEVAL_CONFIDENCE_HIGH_THRESHOLD"],
        message: "Confidence thresholds must be ordered high >= medium >= low.",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface EnvironmentValidationIssue {
  readonly field: keyof Env;
  readonly problems: readonly string[];
}

export interface EnvironmentValidationReport {
  readonly valid: false;
  readonly issues: readonly EnvironmentValidationIssue[];
}

function createEnvironmentValidationReport(
  error: z.ZodError,
): EnvironmentValidationReport {
  const messagesByField = new Map<keyof Env, string[]>();
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "environment") as keyof Env;
    const messages = messagesByField.get(field) ?? [];
    if (!messages.includes(issue.message)) messages.push(issue.message);
    messagesByField.set(field, messages);
  }
  const issues = [...messagesByField.entries()]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([field, messages]) => Object.freeze({
      field,
      problems: Object.freeze([...messages]),
    }));
  return Object.freeze({ valid: false, issues: Object.freeze(issues) });
}

export class EnvironmentValidationError extends Error {
  readonly issues: Readonly<Record<string, readonly string[]>>;
  readonly report: EnvironmentValidationReport;

  constructor(error: z.ZodError) {
    const report = createEnvironmentValidationReport(error);
    const fields = report.issues.map((issue) => String(issue.field));
    super(`Invalid environment configuration: ${fields.join(", ")}.`);
    this.name = "EnvironmentValidationError";
    this.report = report;
    this.issues = Object.freeze(
      Object.fromEntries(
        report.issues.map((issue) => [
          issue.field,
          issue.problems,
        ]),
      ),
    );
  }
}

function hasConfiguredValue(
  input: NodeJS.ProcessEnv | Record<string, unknown>,
  field: string,
): boolean {
  const value = input[field];
  return typeof value === "string" && value.trim().length > 0;
}

function configurationPresenceIssues(
  input: NodeJS.ProcessEnv | Record<string, unknown>,
): z.ZodIssue[] {
  const issues: z.ZodIssue[] = [];
  if (
    !hasConfiguredValue(input, "SUPABASE_SERVICE_ROLE_KEY") &&
    !hasConfiguredValue(input, "SUPABASE_ANON_KEY")
  ) {
    issues.push({
      code: z.ZodIssueCode.custom,
      path: ["SUPABASE_SERVICE_ROLE_KEY"],
      message: "A Supabase service-role or anon key is required.",
    });
  }
  if (input.NODE_ENV === "production") {
    if (!hasConfiguredValue(input, "SUPABASE_SERVICE_ROLE_KEY")) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
        message: "The service-role key is required for durable backend persistence in production.",
      });
    }
    if (
      !hasConfiguredValue(input, "JWT_SECRET") ||
      input.JWT_SECRET === DEVELOPMENT_JWT_SECRET
    ) {
      issues.push({
        code: z.ZodIssueCode.custom,
        path: ["JWT_SECRET"],
        message: "Production JWT secret must be explicitly configured.",
      });
    }
  }
  return issues;
}

export function validateEnv(
  input: NodeJS.ProcessEnv | Record<string, unknown>,
): Env {
  const parsed = EnvSchema.safeParse(input);
  if (!parsed.success) {
    throw new EnvironmentValidationError(new z.ZodError([
      ...parsed.error.issues,
      ...configurationPresenceIssues(input),
    ]));
  }
  return Object.freeze(parsed.data);
}

function loadStartupEnv(): Env {
  try {
    return validateEnv(process.env);
  } catch (error) {
    if (!(error instanceof EnvironmentValidationError)) throw error;
    // Do not print environment values or Zod input details.
    stderrLogger.error("environment_validation_failed", {
      errorMessage: error.message,
      validationReport: error.report,
    });
    process.exit(1);
  }
}

export const env = loadStartupEnv();

function circuitConfig(prefix: "AI" | "EMBEDDING" | "DATABASE" | "CLONE") {
  return Object.freeze({
    minimumSamples: env[`${prefix}_CIRCUIT_MIN_SAMPLES`],
    failureThreshold: env[`${prefix}_CIRCUIT_FAILURE_THRESHOLD`],
    rollingWindowMs: env[`${prefix}_CIRCUIT_WINDOW_MS`],
    openDurationMs: env[`${prefix}_CIRCUIT_OPEN_MS`],
    halfOpenMaxCalls: env.CIRCUIT_HALF_OPEN_MAX_CALLS,
  });
}

export const dependencyCircuitConfig = Object.freeze({
  ai: circuitConfig("AI"),
  embedding: circuitConfig("EMBEDDING"),
  database: circuitConfig("DATABASE"),
  clone: circuitConfig("CLONE"),
});
