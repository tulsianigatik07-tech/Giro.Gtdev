// Helpers for building the typed ApiResponse envelope from inside route handlers.

import type { Context } from "hono";
import type { ApiError, ApiResponse } from "../types/response.js";
import { logger } from "./logger.js";

function getRequestId(c: Context): string {
  return c.get("requestId") ?? "unknown";
}

export function ok<T>(c: Context, data: T, status: 200 | 201 | 503 = 200) {
  const body: ApiResponse<T> = {
    success: true,
    data,
    requestId: getRequestId(c),
  };
  return c.json(body, status);
}

export function fail(
  c: Context,
  error: ApiError,
  status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 503 | 504 = 500,
) {
  if (status === 401 || status === 403) {
    logger.warn("authorization_failure", {
      method: c.req.method,
      route: c.req.path,
      status,
      errorCode: error.code,
    });
  } else if (status === 400 || status === 422) {
    logger.warn("validation_failure", {
      method: c.req.method,
      route: c.req.path,
      status,
      errorCode: error.code,
    });
  }
  const body: ApiResponse<never> = {
    success: false,
    error,
    requestId: getRequestId(c),
  };
  return c.json(body, status);
}
