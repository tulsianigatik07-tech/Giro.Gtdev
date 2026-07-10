// Builds and exports the Hono application without listening.
// Kept separate from index.ts so it's trivial to import for tests later.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { env } from "./config/env.js";
import { requestId } from "./middleware/requestId.js";
import { requestLogger } from "./middleware/logger.js";
import { onError, onNotFound } from "./middleware/errorHandler.js";
import { routes } from "./routes/index.js";
import type { IndexingJobStore } from "./services/indexing/jobs/indexingJobStore.js";
import { runtimeIndexingJobStore } from "./services/indexing/jobs/runtimeIndexingJobStore.js";

type Variables = {
  requestId: string;
  indexingJobStore: IndexingJobStore;
};

export interface CreateAppOptions {
  indexingJobStore?: IndexingJobStore;
}

export function createApp(options: CreateAppOptions = {}) {
  const indexingJobStore = options.indexingJobStore ?? runtimeIndexingJobStore;
  const app = new Hono<{ Variables: Variables }>();

  // Order matters: requestId first so logger and errors can attach it.
  app.use("*", requestId());
  app.use("*", requestLogger());
  app.use("*", async (c, next) => {
    c.set("indexingJobStore", indexingJobStore);
    await next();
  });
  app.use(
    "*",
    cors({
      origin: env.CORS_ORIGINS,
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      exposeHeaders: ["X-Request-Id"],
      credentials: true,
    }),
  );

  app.route("/", routes);

  app.notFound(onNotFound);
  app.onError(onError);

  return app;
}
