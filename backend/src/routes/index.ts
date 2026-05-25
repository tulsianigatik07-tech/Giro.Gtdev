// Mounts all route modules onto a single Hono router.

import { Hono } from "hono";
import { rootRoute } from "@/routes/root.js";
import { healthRoute } from "@/routes/health.js";

export const routes = new Hono();

routes.route("/", rootRoute);
routes.route("/", healthRoute);
