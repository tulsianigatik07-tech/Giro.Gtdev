// Public process and dependency health probes.

import { Hono } from "hono";
import { ok } from "../lib/response.js";
import type { ApplicationReadiness } from "../services/health/readinessService.js";

export type ReadinessCheck = () => Promise<ApplicationReadiness>;

export function createHealthRoute(readinessCheck: ReadinessCheck) {
  const healthRoute = new Hono();

  // Backward-compatible legacy health response.
  healthRoute.get("/health", (c) => {
    return ok(c, {
      status: "ok",
      uptime_s: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  healthRoute.get("/health/live", (c) => {
    return ok(c, { status: "alive", service: "giro-backend" });
  });

  healthRoute.get("/health/ready", async (c) => {
    try {
      const readiness = await readinessCheck();
      return ok(c, readiness, readiness.status === "not_ready" ? 503 : 200);
    } catch {
      return ok(c, { status: "not_ready", checks: [] }, 503);
    }
  });

  return healthRoute;
}
