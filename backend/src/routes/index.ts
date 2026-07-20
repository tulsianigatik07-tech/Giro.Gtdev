// Mounts all route modules onto a single Hono router.

import { Hono } from "hono";
import { rootRoute } from "./root.js";
import {
  createHealthRoute,
  type HealthRouteOptions,
  type ReadinessCheck,
} from "./health.js";
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
import {
  createRateLimitMiddleware,
  type RateLimitPolicy,
} from "../middleware/rateLimiter.js";
import type { MetricsRegistry } from "../observability/metrics.js";
import { createMetricsRoute } from "./metrics.js";
import repositoryIndexingEventsRouter from "./repositoryIndexingEvents.js";

export function createRoutes(
  readinessCheck: ReadinessCheck,
  healthOptions: HealthRouteOptions,
  metrics: MetricsRegistry,
  rateLimitPolicy: RateLimitPolicy = {
    authentication: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      maxRequests: env.RATE_LIMIT_AUTH_MAX_REQUESTS,
    },
    repositoryConnect: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      maxRequests: env.RATE_LIMIT_REPOSITORY_CONNECT_MAX_REQUESTS,
    },
    askGiro: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      maxRequests: env.RATE_LIMIT_ASK_GIRO_MAX_REQUESTS,
    },
    retrievalSearch: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      maxRequests: env.RATE_LIMIT_RETRIEVAL_SEARCH_MAX_REQUESTS,
    },
    indexingOperations: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      maxRequests: env.RATE_LIMIT_INDEXING_MAX_REQUESTS,
    },
    defaultApi: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    },
  },
) {
  const routes = new Hono();

  // Public routes — no authentication required.
  routes.route("/", rootRoute);
  routes.route("/", createHealthRoute(readinessCheck, healthOptions, metrics));
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
  routes.use("/repositories/*", authMiddleware());

  const apiRateLimiter = createRateLimitMiddleware({
    policy: rateLimitPolicy,
    onRejected: () => metrics.incrementRateLimitRejections(),
  });
  routes.use("/auth/*", apiRateLimiter);
  routes.use("/login", apiRateLimiter);
  routes.use("/signup", apiRateLimiter);
  routes.use("/token", apiRateLimiter);
  routes.use("/repos/*", apiRateLimiter);
  routes.use("/context/*", apiRateLimiter);
  routes.use("/search/*", apiRateLimiter);
  routes.use("/chat/*", apiRateLimiter);
  routes.use("/tools/*", apiRateLimiter);
  routes.use("/retrieval/*", apiRateLimiter);
  routes.use("/sessions/*", apiRateLimiter);
  routes.use("/architecture/*", apiRateLimiter);
  routes.use("/indexing/*", apiRateLimiter);
  routes.use("/repositories/*", apiRateLimiter);

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
  routes.route("/repositories", repositoryIndexingEventsRouter);

  return routes;
}
