// Session routes: validation + delegation only. No business logic here.

import { Hono } from "hono";
import { z } from "zod";
import { ok, fail } from "../lib/response.js";
import { logger } from "../lib/logger.js";
import { createValidationError } from "../lib/apiErrors.js";
import { requireAuthenticatedUser } from "../services/auth/authContext.js";
import {
  createNewSession,
  listAllSessions,
  addMessageToSession,
  removeSession,
} from "../services/sessions/sessionService.js";
import { requireSessionAccess } from "../services/sessions/sessionOwnershipGuard.js";
import { requireSessionRepositoryOwnership } from "../services/sessions/sessionRepositoryGuard.js";
import { answerSessionQuestion } from "../services/sessions/questionService.js";
import { getRequestDeadline } from "../middleware/requestTimeout.js";
import { isDeadlineExceeded } from "../runtime/deadline.js";
import {
  QuestionTextSchema,
  RepositoryNameSchema,
  RepositoryOwnerSchema,
} from "../validation/repositorySchemas.js";

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
  owner: RepositoryOwnerSchema,
  repo: RepositoryNameSchema,
  title: z.string().min(1).optional(),
});

const AddMessageBody = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1, "content is required"),
  citations: z.array(CitationSchema).optional(),
});

const AskBody = z.object({
  question: QuestionTextSchema.refine((value) => value.length <= 2000, {
    message: "question must contain at most 2000 character(s)",
  }),
});

const sessionsRouter = new Hono<{ Variables: { requestId: string } }>();

function getSessionAccessFailureResponse(
  c: Parameters<typeof fail>[0],
  access: Extract<ReturnType<typeof requireSessionAccess>, { ok: false }>,
) {
  return fail(c, { code: access.code, message: access.message }, access.status);
}

sessionsRouter.post("/", async (c) => {
  try {
    const parsed = CreateSessionBody.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) {
      return fail(
        c,
        createValidationError(parsed.error.flatten()),
        400,
      );
    }

    const user = requireAuthenticatedUser(c);

    // A session may only be created for a repository owned by this user.
    const repoAccess = requireSessionRepositoryOwnership({
      owner: parsed.data.owner,
      repo: parsed.data.repo,
      userId: user.userId,
    });
    if (!repoAccess.ok) {
      return fail(c, { code: repoAccess.code, message: repoAccess.message }, repoAccess.status);
    }

    const session = createNewSession({
      ...parsed.data,
      userId: user.userId,
    });

    return ok(c, session, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";

    logger.error("session_route_failed", {
      requestId: c.get("requestId"),
      message,
    });

    return fail(c, { code: "session_error", message }, 500);
  }
});

sessionsRouter.get("/", async (c) => {
  try {
    const user = requireAuthenticatedUser(c);

    const sessions = listAllSessions().filter(
      (session) => session.userId === user.userId,
    );

    return ok(c, { sessions, count: sessions.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";

    logger.error("session_route_failed", {
      requestId: c.get("requestId"),
      message,
    });

    return fail(c, { code: "session_error", message }, 500);
  }
});

sessionsRouter.get("/:id", async (c) => {
  try {
    const user = requireAuthenticatedUser(c);
    const id = c.req.param("id");

    const access = requireSessionAccess({
      sessionId: id,
      userId: user.userId,
    });

    if (!access.ok) {
      return getSessionAccessFailureResponse(c, access);
    }

    return ok(c, access.session);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";

    logger.error("session_route_failed", {
      requestId: c.get("requestId"),
      message,
    });

    return fail(c, { code: "session_error", message }, 500);
  }
});

sessionsRouter.post("/:id/messages", async (c) => {
  try {
    const parsed = AddMessageBody.safeParse(await c.req.json().catch(() => null));

    if (!parsed.success) {
      return fail(
        c,
        createValidationError(parsed.error.flatten()),
        400,
      );
    }

    const user = requireAuthenticatedUser(c);
    const id = c.req.param("id");

    const access = requireSessionAccess({
      sessionId: id,
      userId: user.userId,
    });

    if (!access.ok) {
      return getSessionAccessFailureResponse(c, access);
    }

    const session = addMessageToSession(id, parsed.data);

    if (!session) {
      return fail(c, { code: "session_not_found", message: "Session not found" }, 404);
    }

    return ok(c, session);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";

    logger.error("session_route_failed", {
      requestId: c.get("requestId"),
      message,
    });

    return fail(c, { code: "session_error", message }, 500);
  }
});

sessionsRouter.delete("/:id", async (c) => {
  try {
    const user = requireAuthenticatedUser(c);
    const id = c.req.param("id");

    const access = requireSessionAccess({
      sessionId: id,
      userId: user.userId,
    });

    if (!access.ok) {
      return getSessionAccessFailureResponse(c, access);
    }

    const removed = removeSession(id);

    if (!removed) {
      return fail(c, { code: "session_not_found", message: "Session not found" }, 404);
    }

    return ok(c, { id, deleted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";

    logger.error("session_route_failed", {
      requestId: c.get("requestId"),
      message,
    });

    return fail(c, { code: "session_error", message }, 500);
  }
});

sessionsRouter.post("/:id/ask", async (c) => {
  const id = c.req.param("id");
  const parsed = AskBody.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return fail(
      c,
      createValidationError(parsed.error.flatten()),
      400,
    );
  }

  try {
    const user = requireAuthenticatedUser(c);

    const access = requireSessionAccess({
      sessionId: id,
      userId: user.userId,
    });

    if (!access.ok) {
      return getSessionAccessFailureResponse(c, access);
    }

    // The repository this session targets must still be owned by this user.
    const repoAccess = requireSessionRepositoryOwnership({
      owner: access.session.owner,
      repo: access.session.repo,
      userId: user.userId,
    });
    if (!repoAccess.ok) {
      return fail(c, { code: repoAccess.code, message: repoAccess.message }, repoAccess.status);
    }

    const result = await answerSessionQuestion(id, parsed.data.question, {
      signal: getRequestDeadline(c)?.signal,
    });

    if (result === "session_not_found") {
      return fail(c, { code: "session_not_found", message: "Session not found" }, 404);
    }

    return ok(c, result);
  } catch (err) {
    if (isDeadlineExceeded(err)) throw err;
    const message = err instanceof Error ? err.message : "Ask failed";

    logger.error("session_ask_failed", {
      requestId: c.get("requestId"),
      sessionId: id,
      message,
    });

    return fail(c, { code: "ask_error", message }, 500);
  }
});

export default sessionsRouter;
