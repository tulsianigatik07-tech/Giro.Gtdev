import type { ServerType } from "@hono/node-server";

export function stopHttpServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function forceCloseHttpServer(server: ServerType): void {
  if ("closeAllConnections" in server) server.closeAllConnections();
}
