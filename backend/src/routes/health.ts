// GET /health — liveness probe. Reports uptime and timestamp.
// Add downstream checks (db, redis) here once those services exist.

import { Hono } from "hono";
import { ok } from "../lib/response.js";

export const healthRoute = new Hono();

healthRoute.get("/health", (c) => {
  return ok(c, {
    status: "ok",
    uptime_s: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
