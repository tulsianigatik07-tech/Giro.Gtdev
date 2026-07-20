// Public process and dependency health probes.

import { Hono } from "hono";
import { ok } from "../lib/response.js";
import type { ApplicationReadiness } from "../services/health/readinessService.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import { logger } from "../lib/logger.js";
import type {
  ProductionHealthCheck,
  ProductionHealthContract,
} from "../services/health/productionHealth.js";
import type {
  ProductionReadinessCheck,
  ProductionReadinessContract,
} from "../services/health/productionReadiness.js";

export const SERVICE_NAME = "giro-backend";
export const SERVICE_VERSION = "0.1.0";

export type ReadinessCheck = () => Promise<ApplicationReadiness>;

export interface HealthRouteOptions {
  productionHealthCheck: ProductionHealthCheck;
  productionReadinessCheck: ProductionReadinessCheck;
  uptime?: () => number;
  now?: () => Date;
}

export function createHealthRoute(
  readinessCheck: ReadinessCheck,
  options: HealthRouteOptions,
  metrics?: MetricsRegistry,
) {
  const healthRoute = new Hono<{ Variables: { requestId: string } }>();
  const uptime = options.uptime ?? process.uptime;
  const now = options.now ?? (() => new Date());

  healthRoute.get("/ready", async (c) => {
    let readiness: Awaited<ReturnType<ProductionReadinessCheck>>;
    try {
      readiness = await options.productionReadinessCheck();
    } catch {
      readiness = {
        status: "not_ready",
        checks: {
          startup: { status: "fail", required: true },
          supabase: { status: "fail", required: true },
          environment: { status: "fail", required: true },
          storage: { status: "fail", required: true },
          shutdown: { status: "fail", required: true },
          indexingWorker: { status: "fail", required: true },
        },
      };
    }
    for (const [dependency, check] of Object.entries(readiness.checks)) {
      if (check.required && check.status === "fail") {
        logger.warn("readiness_dependency_failed", {
          requestId: c.get("requestId"),
          dependency,
          required: true,
          operation: "production_readiness",
        });
      }
    }
    const contract: ProductionReadinessContract = {
      status: readiness.status,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      timestamp: now().toISOString(),
      checks: readiness.checks,
    };
    return ok(c, contract, readiness.status === "ready" ? 200 : 503);
  });

  healthRoute.get("/health", async (c) => {
    let health: Awaited<ReturnType<ProductionHealthCheck>>;
    try {
      health = await options.productionHealthCheck();
    } catch {
      health = {
        status: "unhealthy",
        checks: {
          api: { status: "healthy", required: true },
          supabase: { status: "unhealthy", required: true },
          indexingWorker: { status: "unhealthy", required: false },
        },
      };
    }
    for (const [dependency, check] of Object.entries(health.checks)) {
      if (check.status === "unhealthy") {
        logger.warn("health_dependency_failed", {
          requestId: c.get("requestId"),
          dependency,
          required: check.required,
        });
      }
    }
    const contract: ProductionHealthContract = {
      status: health.status,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.max(0, Math.floor(uptime())),
      timestamp: now().toISOString(),
      checks: health.checks,
    };
    return ok(c, contract, health.status === "unhealthy" ? 503 : 200);
  });

  healthRoute.get("/health/live", (c) => {
    return ok(c, { status: "alive", service: SERVICE_NAME });
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
