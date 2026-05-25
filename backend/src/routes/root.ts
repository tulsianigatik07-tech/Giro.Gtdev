// GET / — service identity endpoint. Useful for smoke tests and platform health probes.

import { Hono } from "hono";
import { ok } from "@/lib/response.js";

export const rootRoute = new Hono();

rootRoute.get("/", (c) => {
  return ok(c, {
    name: "giro-api",
    version: "0.1.0",
    status: "ok",
  });
});
