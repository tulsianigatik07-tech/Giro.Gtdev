// Per-request structured logger. Logs method, path, status, latency_ms, request_id.

import type { MiddlewareHandler } from "hono";
import { logger } from "@/lib/logger.js";

export const requestLogger = (): MiddlewareHandler => {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const latency = Math.round(performance.now() - start);

    logger.info("http_request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latency_ms: latency,
      request_id: c.get("requestId"),
    });
  };
};
