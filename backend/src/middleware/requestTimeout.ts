import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { createApiError } from "../lib/apiErrors.js";
import type { RequestContextLogger } from "./requestContext.js";
import { fail } from "../lib/response.js";
import { logger as defaultLogger } from "../lib/logger.js";
import { createDeadline, isDeadlineExceeded, waitForDeadline, type Deadline, type DeadlineTimerOptions } from "../runtime/deadline.js";

export type RequestDeadlineVariables = { requestDeadline: Deadline };

export interface RequestTimeoutOptions extends DeadlineTimerOptions {
  timeoutMs: number;
  logger?: Pick<RequestContextLogger, "error">;
  onTimeout?: () => void;
}

export function createRequestTimeoutMiddleware(options: RequestTimeoutOptions): MiddlewareHandler {
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? Date.now;
  return async (c, next) => {
    const deadline = createDeadline(options.timeoutMs, options);
    c.set("requestDeadline", deadline);
    const startedAt = now();
    try {
      await waitForDeadline(next(), deadline);
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
      return fail(
        c,
        createApiError("request_timeout", "The request could not be completed within the allowed time."),
        504,
      );
    } finally {
      deadline.dispose();
    }
  };
}

export function getRequestDeadline(c: { get(key: "requestDeadline"): Deadline | undefined }): Deadline | undefined {
  return c.get("requestDeadline");
}
