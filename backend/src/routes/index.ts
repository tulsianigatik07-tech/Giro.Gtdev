// Mounts all route modules onto a single Hono router.

import { Hono } from "hono";
import { rootRoute } from "./root.js";
import { healthRoute } from "./health.js";
import { repositoriesRoute } from "./repositories.js";
import contextRouter from "./context.js";
import searchRouter from "./search.js";
import chatRouter from "./chat.js";
import toolsRouter from "./tools.js";
import retrievalRouter from "./retrieval.js";
import sessionsRouter from "./sessions.js";

export const routes = new Hono();

routes.route("/", rootRoute);
routes.route("/", healthRoute);
routes.route("/repos", repositoriesRoute);
routes.route("/context", contextRouter);
routes.route("/search", searchRouter);
routes.route("/chat", chatRouter);
routes.route("/tools", toolsRouter);
routes.route("/retrieval", retrievalRouter);
routes.route("/sessions", sessionsRouter);
