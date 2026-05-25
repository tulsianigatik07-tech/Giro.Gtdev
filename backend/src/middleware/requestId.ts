// Generates or propagates a request id and exposes it via c.get("requestId")
// and the X-Request-Id response header. Used for log correlation.

import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const HEADER = "x-request-id";

export const requestId = (): MiddlewareHandler => {
  return async (c, next) => {
    const incoming = c.req.header(HEADER);
    const id = incoming && incoming.length > 0 ? incoming : randomUUID();
    c.set("requestId", id);
    c.header(HEADER, id);
    await next();
  };
};
