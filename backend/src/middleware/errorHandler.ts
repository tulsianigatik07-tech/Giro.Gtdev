// Centralized error handler. Converts thrown errors into the typed ApiResponse shape.
// Hides stack traces in production.

import type { ErrorHandler, NotFoundHandler } from "hono";
import { routePath } from "hono/route";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { fail } from "../lib/response.js";
import { createApiError } from "../lib/apiErrors.js";
import { isDependencyUnavailable } from "../runtime/circuitBreaker.js";
import { IndexingJobPersistenceError } from "../services/indexing/jobs/supabaseIndexingJobStore.js";

const MAX_LOG_MESSAGE_LENGTH = 1_000;
const MAX_LOG_STACK_LENGTH = 12_000;

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/([?&](?:key|token|secret|api_key|apikey)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/((?:key|token|secret|authorization)\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

export function safeErrorLogFields(
  error: unknown,
  nodeEnv: "development" | "test" | "production" = env.NODE_ENV,
): Record<string, unknown> {
  const errorName = error instanceof Error && error.name.trim()
    ? error.name.trim()
    : "UnknownError";
  const rawMessage = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "Unknown request error.";
  const fields: Record<string, unknown> = {
    errorName: bounded(redactSensitiveText(errorName), 120),
    errorMessage: bounded(redactSensitiveText(rawMessage), MAX_LOG_MESSAGE_LENGTH),
  };
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      fields.errorCode = bounded(redactSensitiveText(code), 120);
    }
    const cause = (error as { cause?: unknown }).cause;
    if (cause) {
      const causeName = cause instanceof Error
        ? cause.name
        : typeof cause === "object" && typeof (cause as { name?: unknown }).name === "string"
          ? String((cause as { name: string }).name)
          : "UnknownError";
      const causeMessage = cause instanceof Error
        ? cause.message
        : typeof cause === "object" && typeof (cause as { message?: unknown }).message === "string"
          ? String((cause as { message: string }).message)
          : "Unknown error cause.";
      fields.causeName = bounded(redactSensitiveText(causeName), 120);
      fields.causeMessage = bounded(
        redactSensitiveText(causeMessage),
        MAX_LOG_MESSAGE_LENGTH,
      );
    }
  }
  if (error instanceof Error && error.stack) {
    const cause = error.cause;
    const stack = cause instanceof Error && cause.stack
      ? `${error.stack}\nCaused by: ${cause.stack}`
      : error.stack;
    fields.stack = bounded(redactSensitiveText(stack), MAX_LOG_STACK_LENGTH);
  }
  return fields;
}

export const onError: ErrorHandler = (err, c) => {
  const requestId = c.get("requestId");
  const requestLogger = c.get("requestLogger") ?? logger;

  if (isDependencyUnavailable(err)) {
    logger.warn("dependency_unavailable", { requestId });
    return fail(
      c,
      createApiError("dependency_unavailable", "A required service is temporarily unavailable."),
      503,
    );
  }

  if (err instanceof HTTPException) {
    const res = err.getResponse();
    logger.warn("http_exception", {
      requestId,
      status: res.status,
      message: err.message,
    });
    return fail(
      c,
      { code: "http_error", message: err.message },
      res.status as 400 | 401 | 403 | 404 | 409 | 422 | 500,
    );
  }

  if (err instanceof ZodError) {
    logger.warn("validation_error", {
      requestId,
      issues: err.flatten().fieldErrors,
    });
    return fail(
      c,
      {
        code: "validation_error",
        message: "Invalid request payload",
        details: err.flatten().fieldErrors,
      },
      422,
    );
  }

  const matchedRoute = routePath(c, -1);
  const correlation = c.get("requestLogContext");
  requestLogger.error("unhandled_error", {
    requestId,
    route: matchedRoute && matchedRoute !== "*" ? matchedRoute : c.req.path,
    ...(correlation?.repositoryId ? { repositoryId: correlation.repositoryId } : {}),
    ...safeErrorLogFields(err),
  });

  return fail(
    c,
    {
      code: "internal_error",
      message: err instanceof IndexingJobPersistenceError
        ? err.message
        : "Internal server error",
    },
    500,
  );
};

export const onNotFound: NotFoundHandler = (c) => {
  return fail(
    c,
    {
      code: "not_found",
      message: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404,
  );
};
