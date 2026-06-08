// Session routes: validation + delegation only. No business logic here.

import { Hono } from "hono";
import { requireAuthenticatedUser } from "../services/auth/authContext.js";
import { z } from "zod";
import { ok, fail } from "../lib/response.js";
import { logger } from "../lib/logger.js";
import {
  createNewSession,
  getSessionById,
  listAllSessions,
  addMessageToSession,
  removeSession,
} from "../services/sessions/sessionService.js";
import { answerSessionQuestion } from "../services/sessions/questionService.js";

const CitationSchema = z
  .object({
    filePath: z.string().min(1),
    startLine: z.number().int(),
    endLine: z.number().int(),
    snippet: z.string(),
  })
  .refine((c) => c.endLine >= c.startLine, {
    message: "endLine must be >= startLine",
  });

const CreateSessionBody = z.object({
  owner: z.string().min(1, "owner is required"),
  repo: z.string().min(1, "repo is required"),
  title: z.string().min(1).optional(),
});

const AddMessageBody = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1, "content is required"),
  citations: z.array(CitationSchema).optional(),
});

const AskBody = z.object({
  question: z.string().min(1, "question is required").max(2000),
});

const sessionsRouter = new Hono<{ Variables: { requestId: string } }>();

sessionsRouter.post("/", async (c) => {
  try {
    const parsed = CreateSessionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return fail(c, { code: "validation_error", message: "Invalid request body", details: parsed.error.flatten() }, 400);
    }

    const user = requireAuthenticatedUser(c);

    const session = createNewSession({
      ...parsed.data,
      userId: user.userId,
    });

    return ok(c, session, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error("session_route_failed", { requestId: c.get("requestId"), message });
    return fail(c, { code: "session_error", message }, 500);
  }
});

sessionsRouter.get("/", async (c) => {
  try {
    const sessions = listAllSessions();
    return ok(c, { sessions, count: sessions.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error("session_route_failed", { requestId: c.get("requestId"), message });
    return fail(c, { code: "session_error", message }, 500);
  }
});

sessionsRouter.get("/:id", async (c) => {
  try {
    const session = getSessionById(c.req.param("id"));
    if (!session) {
      return fail(c, { code: "session_not_found", message: "Session not found" }, 404);
    }
    return ok(c, session);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error("session_route_failed", { requestId: c.get("requestId"), message });
    return fail(c, { code: "session_error", message }, 500);
  }
});

sessionsRouter.post("/:id/messages", async (c) => {
  try {
    const parsed = AddMessageBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return fail(c, { code: "validation_error", message: "Invalid request body", details: parsed.error.flatten() }, 400);
    }
    const session = addMessageToSession(c.req.param("id"), parsed.data);
    if (!session) {
      return fail(c, { code: "session_not_found", message: "Session not found" }, 404);
    }
    return ok(c, session);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error("session_route_failed", { requestId: c.get("requestId"), message });
    return fail(c, { code: "session_error", message }, 500);
  }
});

sessionsRouter.delete("/:id", async (c) => {
  try {
    const removed = removeSession(c.req.param("id"));
    if (!removed) {
      return fail(c, { code: "session_not_found", message: "Session not found" }, 404);
    }
    return ok(c, { id: c.req.param("id"), deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error("session_route_failed", { requestId: c.get("requestId"), message });
    return fail(c, { code: "session_error", message }, 500);
  }
});

sessionsRouter.post("/:id/ask", async (c) => {
  const id = c.req.param("id");
  const parsed = AskBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return fail(c, { code: "validation_error", message: "question is required", details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await answerSessionQuestion(id, parsed.data.question);
    if (result === "session_not_found") {
      return fail(c, { code: "session_not_found", message: "Session not found" }, 404);
    }
    return ok(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ask failed";
    logger.error("session_ask_failed", { requestId: c.get("requestId"), sessionId: id, message });
    return fail(c, { code: "ask_error", message }, 500);
  }
});

export default sessionsRouter;
