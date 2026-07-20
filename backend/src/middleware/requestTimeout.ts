import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { createApiError } from "../lib/apiErrors.js";
import type { RequestContextLogger } from "./requestContext.js";
import { fail } from "../lib/response.js";
import { logger as defaultLogger } from "../lib/logger.js";
import { createDeadline, isDeadlineExceeded, waitForDeadline, type Deadline, type DeadlineTimerOptions } from "../runtime/deadline.js";

export type RequestDeadlineVariables = { requestDeadline: Deadline };
export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;

export interface RequestTimeoutOptions extends DeadlineTimerOptions {
  timeoutMs: number;
  logger?: Pick<RequestContextLogger, "error">;
  onTimeout?: () => void;
  shouldTimeout?: (path: string) => boolean;
  getParentSignal?: (request: Request) => AbortSignal | undefined;
}

export function isRequestTimeoutExemptPath(path: string): boolean {
  return path === "/ready" || path === "/health" || path.startsWith("/health/");
}

export function createRequestTimeoutMiddleware(options: RequestTimeoutOptions): MiddlewareHandler {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < MIN_REQUEST_TIMEOUT_MS ||
    options.timeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Request timeout must be an integer between ${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS} milliseconds.`,
    );
  }
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? Date.now;
  return async (c, next) => {
    if (options.shouldTimeout && !options.shouldTimeout(c.req.path)) {
      return next();
    }
    const parentSignal = options.getParentSignal?.(c.req.raw) ??
      options.parentSignal ?? c.req.raw.signal;
    const deadline = createDeadline(options.timeoutMs, {
      now: options.now,
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
      parentSignal,
    });
    c.set("requestDeadline", deadline);
    const startedAt = now();
    const downstream = Promise.resolve().then(next);
    try {
      // Register the timeout race before downstream work can subscribe to the
      // same abort signal, so expiry deterministically owns the HTTP response.
      await waitForDeadline(downstream, deadline);
    } catch (error) {
      if (!isDeadlineExceeded(error)) throw error;
      options.onTimeout?.();
      logger.error("request_timeout", {
        requestId: c.get("requestId"),
        route: routePath(c, -1) || "__unmatched__",
        method: c.req.method,
        durationMs: Math.max(0, now() - startedAt),
      });
      if (c.res.bodyUsed) return;
      const timeoutResponse = fail(
        c,
        createApiError("request_timeout", "The request could not be completed within the allowed time."),
        504,
      );
      // A handler that ignores the signal may still finish later. Hono shares
      // its mutable context with that handler, so restore the already-selected
      // timeout response after downstream settles without claiming cancellation.
      const restoreTimeoutResponse = () => {
        if (timeoutResponse.bodyUsed) return;
        try {
          c.res = timeoutResponse.clone();
        } catch {
          // The response may already be committed by the server adapter.
        }
      };
      void downstream.then(restoreTimeoutResponse, restoreTimeoutResponse);
      return timeoutResponse;
    } finally {
      deadline.dispose();
    }
  };
}

export function getRequestDeadline(c: { get(key: "requestDeadline"): Deadline | undefined }): Deadline | undefined {
  return c.get("requestDeadline");
}
