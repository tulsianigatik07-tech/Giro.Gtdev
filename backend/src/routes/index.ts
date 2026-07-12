// Mounts all route modules onto a single Hono router.

import { Hono } from "hono";
import { rootRoute } from "./root.js";
import { createHealthRoute, type ReadinessCheck } from "./health.js";
import { repositoriesRoute } from "./repositories.js";
import contextRouter from "./context.js";
import searchRouter from "./search.js";
import chatRouter from "./chat.js";
import toolsRouter from "./tools.js";
import retrievalRouter from "./retrieval.js";
import sessionsRouter from "./sessions.js";
import architectureRouter from "./architecture.js";
import indexingRouter from "./indexing.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import { env } from "../config/env.js";
import { rateLimiter } from "../middleware/rateLimiter.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import { createMetricsRoute } from "./metrics.js";

export function createRoutes(readinessCheck: ReadinessCheck, metrics: MetricsRegistry) {
  const routes = new Hono();

  // Public routes — no authentication required.
  routes.route("/", rootRoute);
  routes.route("/", createHealthRoute(readinessCheck, metrics));
  routes.route("/", createMetricsRoute(metrics));

  // Protected route middleware.
  routes.use("/repos/*", authMiddleware());
  routes.use("/context/*", authMiddleware());
  routes.use("/search/*", authMiddleware());
  routes.use("/chat/*", authMiddleware());
  routes.use("/tools/*", authMiddleware());
  routes.use("/retrieval/*", authMiddleware());
  routes.use("/sessions/*", authMiddleware());
  routes.use("/architecture/*", authMiddleware());
  routes.use("/indexing/*", authMiddleware());

  const expensiveEndpointLimiter = rateLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    onRejected: () => metrics.incrementRateLimitRejections(),
  });
  routes.use("/repos/connect", expensiveEndpointLimiter);
  routes.use("/repos/search/*", expensiveEndpointLimiter);
  routes.use("/search/*", expensiveEndpointLimiter);
  routes.use("/chat/*", expensiveEndpointLimiter);
  routes.use("/retrieval/*", expensiveEndpointLimiter);
  routes.use("/sessions/:id/ask", expensiveEndpointLimiter);

  // Protected routes.
  routes.route("/repos", repositoriesRoute);
  routes.route("/context", contextRouter);
  routes.route("/search", searchRouter);
  routes.route("/chat", chatRouter);
  routes.route("/tools", toolsRouter);
  routes.route("/retrieval", retrievalRouter);
  routes.route("/sessions", sessionsRouter);
  routes.route("/architecture", architectureRouter);
  routes.route("/indexing", indexingRouter);

  return routes;
}
