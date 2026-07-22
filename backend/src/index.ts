// Process entrypoint. Boots the HTTP server using @hono/node-server.

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { env } from "./config/env.js";
import { flushLogs, logger } from "./lib/logger.js";
import { closeSupabaseConnections } from "./lib/supabase.js";
import { createApp } from "./app.js";
import {
  createBackendShutdown,
  installShutdownSignalHandlers,
} from "./runtime/backendShutdown.js";
import {
  forceCloseHttpServer,
  stopHttpServer,
} from "./runtime/httpServerShutdown.js";
import { stopRegisteredIndexingWorkers } from "./runtime/indexingWorkerShutdown.js";
import { runtimeIndexingJobStore } from "./services/indexing/jobs/runtimeIndexingJobStore.js";
import { recoverIndexingJobsOnStartup } from "./services/indexing/jobs/indexingJobStartupRecovery.js";
import { runtimeRepositoryDeletionService } from "./services/repository/repositoryDeletionService.js";
import { rateLimitBackend, runtimeRateLimitStore } from "./services/rateLimit/runtimeRateLimitStore.js";

let server: ServerType;
let startupCompleted = false;
const coordinator = createBackendShutdown({
  logger,
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  stopAcceptingRequests: () => stopHttpServer(server),
  stopIndexingWorkers: stopRegisteredIndexingWorkers,
  closeDatabase: closeSupabaseConnections,
  flushLogs,
  forceStop: () => forceCloseHttpServer(server),
});
const app = createApp({
  isShuttingDown: coordinator.isShuttingDown,
  isStartupComplete: () => startupCompleted,
});

try {
  await runtimeRateLimitStore.verify();
  logger.info("rate_limit_backend_verified", { backend: rateLimitBackend });
} catch {
  logger.error("rate_limit_backend_verification_failed", {
    source: "backend_startup",
    backend: rateLimitBackend,
    reasonCode: "rate_limit_backend_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await recoverIndexingJobsOnStartup({
    jobStore: runtimeIndexingJobStore,
    logger,
    leaseDurationMs: env.INDEXING_WORKER_STALE_CLAIM_MS,
    retryDelayMs: env.INDEXING_WORKER_RETRY_BASE_MS,
  });
} catch {
  logger.error("indexing_recovery_failed", {
    source: "backend_startup",
    reasonCode: "durable_recovery_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await runtimeRepositoryDeletionService.recoverPendingFilesystemCleanup();
} catch {
  logger.error("repository_deletion_recovery_failed", {
    source: "backend_startup",
    reasonCode: "durable_cleanup_recovery_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    startupCompleted = true;
    logger.info("server_started", {
      port: info.port,
      env: env.NODE_ENV,
    });
  },
);

installShutdownSignalHandlers({
  coordinator,
  subscribe: (signal, handler) => {
    process.on(signal, handler);
    return () => process.off(signal, handler);
  },
  setExitCode: (code) => {
    const existingFailure = process.exitCode !== undefined && process.exitCode !== 0;
    process.exitCode = existingFailure ? 1 : code;
  },
  forceExit: (code) => process.exit(code),
});
