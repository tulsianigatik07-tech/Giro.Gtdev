// Process entrypoint. Boots the HTTP server using @hono/node-server.

import { serve } from "@hono/node-server";
import { env } from "@/config/env.js";
import { logger } from "@/lib/logger.js";
import { createApp } from "@/app.js";

const app = createApp();

serve(
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

function shutdown(signal: string) {
  logger.info("server_shutdown", { signal });
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
