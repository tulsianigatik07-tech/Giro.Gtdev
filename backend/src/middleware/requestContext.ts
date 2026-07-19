import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { logger as defaultLogger } from "../lib/logger.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";

export const REQUEST_ID_HEADER = "X-Request-ID";
export const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export interface RequestLogContext {
  readonly repositoryId?: string;
  readonly jobId?: string;
}

export interface RequestContextVariables {
  requestId: string;
  requestStartedAtMs: number;
  requestLogContext?: RequestLogContext;
  requestLogger: RequestContextLogger;
}

export interface RequestContextLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface RequestContextOptions {
  generateRequestId?: () => string;
  monotonicNow?: () => number;
  logger?: RequestContextLogger;
}

export function isValidRequestId(value: string | undefined): value is string {
  return Boolean(
    value &&
      value.length <= MAX_REQUEST_ID_LENGTH &&
      REQUEST_ID_PATTERN.test(value) &&
      !value.includes(".."),
  );
}

export function setRequestLogContext(
  c: Context,
  context: RequestLogContext,
): void {
  c.set("requestLogContext", Object.freeze({ ...context }));
}

export function createRequestContextMiddleware(
  options: RequestContextOptions = {},
): MiddlewareHandler<{ Variables: RequestContextVariables }> {
  const generateRequestId = options.generateRequestId ?? randomUUID;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const logger = options.logger ?? defaultLogger;

  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const requestId = isValidRequestId(incoming) ? incoming : generateRequestId();
    const startedAt = monotonicNow();
    c.set("requestId", requestId);
    c.set("requestStartedAtMs", startedAt);
    c.set("requestLogger", logger);
    c.header(REQUEST_ID_HEADER, requestId);

    try {
      await next();
      const user = getAuthenticatedUser(c);
      const correlation = c.get("requestLogContext");
      const matchedRoute = routePath(c, -1);
      logger.info("request_completed", {
        requestId,
        method: c.req.method,
        route: matchedRoute && matchedRoute !== "*" ? matchedRoute : c.req.path,
        status: c.res.status,
        durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
        ...(user ? { userId: user.userId } : {}),
        ...correlation,
      });
    } catch (error) {
      const matchedRoute = routePath(c, -1);
      logger.error("request_failed", {
        requestId,
        method: c.req.method,
        route: matchedRoute && matchedRoute !== "*" ? matchedRoute : c.req.path,
        status: 500,
        durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      });
      throw error;
    }
  };
}
