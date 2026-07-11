// Process entrypoint. Boots the HTTP server using @hono/node-server.

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";
import {
  createShutdownCoordinator,
  type ShutdownResult,
  type ShutdownSignal,
} from "./runtime/shutdownCoordinator.js";
import {
  forceCloseHttpServer,
  stopHttpServer,
} from "./runtime/httpServerShutdown.js";

let server: ServerType;
const coordinator = createShutdownCoordinator({
  logger,
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  stopAcceptingRequests: () => stopHttpServer(server),
  forceStop: () => forceCloseHttpServer(server),
});
const app = createApp({ isShuttingDown: coordinator.isShuttingDown });

server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    logger.info("server_started", {
      port: info.port,
      env: env.NODE_ENV,
    });
  },
);

function applyShutdownResult(result: ShutdownResult): void {
  const existingFailure =
    process.exitCode !== undefined && process.exitCode !== 0;
  process.exitCode = existingFailure ? 1 : result.exitCode;
  if (result.outcome === "timeout" || result.outcome === "forced") {
    process.exit(1);
  }
}

function shutdown(signal: ShutdownSignal): void {
  void coordinator.requestShutdown(signal).then(applyShutdownResult);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
