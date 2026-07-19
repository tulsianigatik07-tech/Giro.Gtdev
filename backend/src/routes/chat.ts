// Deprecated legacy chat endpoint. Ask Giro is repository/session scoped at
// POST /sessions/:id/ask so authorization, retrieval, persistence, and history
// cannot be bypassed through an independent implementation.

import { Hono } from "hono";
import { fail } from "../lib/response.js";

const chatRouter = new Hono<{ Variables: { requestId: string } }>();

chatRouter.post("/", (c) =>
  fail(c, {
    code: "endpoint_deprecated",
    message: "Use POST /sessions/:id/ask for repository-grounded answers.",
  }, 410)
);

export default chatRouter;
