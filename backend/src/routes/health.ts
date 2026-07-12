// Public process and dependency health probes.

import { Hono } from "hono";
import { ok } from "../lib/response.js";
import type { ApplicationReadiness } from "../services/health/readinessService.js";
import type { MetricsRegistry } from "../observability/metrics.js";

export type ReadinessCheck = () => Promise<ApplicationReadiness>;

export function createHealthRoute(readinessCheck: ReadinessCheck, metrics?: MetricsRegistry) {
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
      metrics?.setReadiness(readiness.status !== "not_ready");
      return ok(c, readiness, readiness.status === "not_ready" ? 503 : 200);
    } catch {
      metrics?.setReadiness(false);
      return ok(c, { status: "not_ready", checks: [] }, 503);
    }
  });

  return healthRoute;
}
