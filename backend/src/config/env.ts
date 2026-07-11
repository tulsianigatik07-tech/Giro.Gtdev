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
  })
  .superRefine((value, context) => {
    if (!value.SUPABASE_SERVICE_ROLE_KEY && !value.SUPABASE_ANON_KEY) {
      context.addIssue({
        code: "custom",
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
        message: "A Supabase service-role or anon key is required.",
      });
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
