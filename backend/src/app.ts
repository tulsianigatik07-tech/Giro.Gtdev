// Builds and exports the Hono application without listening.
// Kept separate from index.ts so it's trivial to import for tests later.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./config/env.js";
import {
  createRequestContextMiddleware,
  type RequestContextOptions,
  type RequestContextVariables,
} from "./middleware/requestContext.js";
import { onError, onNotFound } from "./middleware/errorHandler.js";
import { createRoutes } from "./routes/index.js";
import type { HealthRouteOptions, ReadinessCheck } from "./routes/health.js";
import type { IndexingJobStore } from "./services/indexing/jobs/indexingJobStore.js";
import { runtimeIndexingJobStore } from "./services/indexing/jobs/runtimeIndexingJobStore.js";
import { createRuntimeReadinessCheck } from "./services/health/runtimeReadiness.js";
import { createMetricsMiddleware } from "./middleware/metricsMiddleware.js";
import { runtimeMetrics, type MetricsRegistry } from "./observability/metrics.js";
import { logger } from "./lib/logger.js";
import { IndexingProgressPublisher } from "./services/indexing/events/indexingProgressPublisher.js";
import { runtimeIndexingProgressPublisher } from "./services/indexing/events/runtimeIndexingProgressPublisher.js";
import { RetrievalCache } from "./services/retrieval/cache/retrievalCache.js";
import { runtimeRetrievalCache } from "./services/retrieval/cache/runtimeRetrievalCache.js";
import type { RateLimitPolicy } from "./middleware/rateLimiter.js";
import { createRuntimeProductionHealthCheck } from "./services/health/runtimeProductionHealth.js";
import type { ProductionHealthCheck } from "./services/health/productionHealth.js";

type Variables = RequestContextVariables & {
  indexingJobStore: IndexingJobStore;
  indexingProgressPublisher: IndexingProgressPublisher;
  retrievalCache: RetrievalCache;
};

export interface CreateAppOptions {
  indexingJobStore?: IndexingJobStore;
  readinessCheck?: ReadinessCheck;
  isShuttingDown?: () => boolean;
  requestContext?: RequestContextOptions;
  metrics?: MetricsRegistry;
  indexingProgressPublisher?: IndexingProgressPublisher;
  retrievalCache?: RetrievalCache;
  productionHealthCheck?: ProductionHealthCheck;
  healthClock?: Pick<HealthRouteOptions, "uptime" | "now">;
  rateLimitPolicy?: RateLimitPolicy;
}

export function createApp(options: CreateAppOptions = {}) {
  const indexingJobStore = options.indexingJobStore ?? runtimeIndexingJobStore;
  const metrics = options.metrics ?? runtimeMetrics;
  const indexingProgressPublisher = options.indexingProgressPublisher ?? (
    indexingJobStore === runtimeIndexingJobStore && metrics === runtimeMetrics
      ? runtimeIndexingProgressPublisher
      : new IndexingProgressPublisher({ jobStore: indexingJobStore, metrics, logger })
  );
  const retrievalCache = options.retrievalCache ?? (
    indexingJobStore === runtimeIndexingJobStore && metrics === runtimeMetrics
      ? runtimeRetrievalCache
      : new RetrievalCache({
          ttlMs: env.RETRIEVAL_CACHE_TTL_MS,
          maxEntries: env.RETRIEVAL_CACHE_MAX_ENTRIES,
          metrics,
          logger,
          versionProvider: async (repositoryId) => {
            const job = await indexingJobStore.getLatestRepositoryJob(repositoryId);
            return job
              ? [job.jobId, job.attempt, job.status, job.currentStage, job.progress].join(":")
              : "unversioned";
          },
        })
  );
  const readinessCheck =
    options.readinessCheck ??
    createRuntimeReadinessCheck({
      indexingJobStore,
      isShuttingDown: options.isShuttingDown,
    });
  const productionHealthCheck = options.productionHealthCheck ??
    createRuntimeProductionHealthCheck();
  const app = new Hono<{ Variables: Variables }>();

  // Order matters: correlation context wraps every later middleware and route.
  app.use("*", createRequestContextMiddleware(options.requestContext));
  app.use("*", createMetricsMiddleware(metrics));
  app.use("*", async (c, next) => {
    c.set("indexingJobStore", indexingJobStore);
    c.set("indexingProgressPublisher", indexingProgressPublisher);
    c.set("retrievalCache", retrievalCache);
    await next();
  });
  app.use(
    "*",
    cors({
      origin: env.CORS_ORIGINS,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
      exposeHeaders: [
        "X-Request-ID",
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "Retry-After",
        "X-Retrieval-Confidence",
      ],
      credentials: true,
    }),
  );

  app.route("/", createRoutes(
    readinessCheck,
    { productionHealthCheck, ...options.healthClock },
    metrics,
    options.rateLimitPolicy,
  ));

  app.notFound(onNotFound);
  app.onError(onError);

  return app;
}
