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
