import { Hono } from "hono";
import type { MetricsRegistry } from "../observability/metrics.js";

export function createMetricsRoute(registry: MetricsRegistry) {
  const metricsRoute = new Hono();
  metricsRoute.get("/metrics", () => new Response(registry.render(), {
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  }));
  return metricsRoute;
}
