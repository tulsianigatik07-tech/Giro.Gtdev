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
import architectureRouter from "./architecture.js";
import indexingRouter from "./indexing.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

export const routes = new Hono();

// Public routes — no authentication required.
routes.route("/", rootRoute);
routes.route("/", healthRoute);

// Protected route middleware.
routes.use("/repos/*", authMiddleware());
routes.use("/context/*", authMiddleware());
routes.use("/search/*", authMiddleware());
routes.use("/chat/*", authMiddleware());
routes.use("/tools/*", authMiddleware());
routes.use("/retrieval/*", authMiddleware());
routes.use("/sessions/*", authMiddleware());
routes.use("/architecture/*", authMiddleware());
routes.use("/indexing/*", authMiddleware());

// Protected routes.
routes.route("/repos", repositoriesRoute);
routes.route("/context", contextRouter);
routes.route("/search", searchRouter);
routes.route("/chat", chatRouter);
routes.route("/tools", toolsRouter);
routes.route("/retrieval", retrievalRouter);
routes.route("/sessions", sessionsRouter);
routes.route("/architecture", architectureRouter);
routes.route("/indexing", indexingRouter);
