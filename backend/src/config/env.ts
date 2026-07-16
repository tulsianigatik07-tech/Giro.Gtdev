// Loads and validates all runtime environment variables once at process startup.

import "dotenv/config";
import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const EnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().positive().max(65_535).default(8000),
    CORS_ORIGINS: z
      .string()
      .default("http://localhost:3000")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().url()).min(1)),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    JWT_SECRET: z.string().min(16).default("dev-insecure-secret-change-me"),
    SUPABASE_URL: z.string().url(),
    SUPABASE_ANON_KEY: optionalNonEmptyString,
    SUPABASE_SERVICE_ROLE_KEY: optionalNonEmptyString,
    OPENAI_API_KEY: z.string().trim().min(20),
    EMBEDDINGS_PROVIDER: z.enum(["mock", "openai"]).default("mock"),
    MODEL_NAME: z.string().trim().min(1).default("gpt-4.1-mini"),
    INDEXING_WORKER_ID: optionalNonEmptyString,
    RETRIEVAL_CACHE_TTL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    RETRIEVAL_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(10_000).default(500),
    RETRIEVAL_STITCH_LINE_GAP: z.coerce.number().int().min(0).max(1_000).default(0),
    QUERY_EXPANSION_MAX_TERMS: z.coerce.number().int().min(0).max(50).default(8),
    QUERY_EXPANSION_SCORE_PENALTY: z.coerce.number().min(0.1).max(1).default(0.85),
    SHUTDOWN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(10_000),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    EMBEDDING_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    DATABASE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
    REPOSITORY_CLONE_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
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
    if (!value.SUPABASE_SERVICE_ROLE_KEY && !value.SUPABASE_ANON_KEY) {
      context.addIssue({
        code: "custom",
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
        message: "A Supabase service-role or anon key is required.",
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
  });

export type Env = z.infer<typeof EnvSchema>;

export class EnvironmentValidationError extends Error {
  readonly issues: Readonly<Record<string, readonly string[]>>;

  constructor(error: z.ZodError) {
    const fieldErrors = error.flatten().fieldErrors;
    const fields = Object.keys(fieldErrors).sort();
    super(`Invalid environment configuration: ${fields.join(", ")}.`);
    this.name = "EnvironmentValidationError";
    this.issues = Object.freeze(
      Object.fromEntries(
        fields.map((field) => [
          field,
          Object.freeze([...(fieldErrors[field] ?? [])]),
        ]),
      ),
    );
  }
}

export function validateEnv(
  input: NodeJS.ProcessEnv | Record<string, unknown>,
): Env {
  const parsed = EnvSchema.safeParse(input);
  if (!parsed.success) throw new EnvironmentValidationError(parsed.error);
  return Object.freeze(parsed.data);
}

function loadStartupEnv(): Env {
  try {
    return validateEnv(process.env);
  } catch (error) {
    if (!(error instanceof EnvironmentValidationError)) throw error;
    // Do not print environment values or Zod input details.
    console.error(error.message);
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
