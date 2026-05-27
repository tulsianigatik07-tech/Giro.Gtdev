// Centralized error handler. Converts thrown errors into the typed ApiResponse shape.
// Hides stack traces in production.

import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { fail } from "../lib/response.js";

export const onError: ErrorHandler = (err, c) => {
  const requestId = c.get("requestId");

  if (err instanceof HTTPException) {
    const res = err.getResponse();
    logger.warn("http_exception", {
      request_id: requestId,
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
      request_id: requestId,
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

  logger.error("unhandled_error", {
    request_id: requestId,
    message: err.message,
    ...(env.NODE_ENV !== "production" ? { stack: err.stack } : {}),
  });

  return fail(
    c,
    {
      code: "internal_error",
      message:
        env.NODE_ENV === "production" ? "Internal server error" : err.message,
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
