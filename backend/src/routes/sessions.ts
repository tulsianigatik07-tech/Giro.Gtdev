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
import { answerSessionQuestion } from "../services/sessions/questionService.js";
import { getRequestDeadline } from "../middleware/requestTimeout.js";
import { setRequestLogContext } from "../middleware/requestContext.js";
import { isDeadlineExceeded } from "../runtime/deadline.js";
import { isDependencyUnavailable } from "../runtime/circuitBreaker.js";
import {
  QuestionTextSchema,
  RepositoryNameSchema,
  RepositoryOwnerSchema,
  RepositoryIdSchema,
  FilePathSchema,
} from "../validation/repositorySchemas.js";
import type { RetrievalCache } from "../services/retrieval/cache/retrievalCache.js";
import { getRepositoryIndexMetadata } from "../services/repository/indexingService.js";
import { authorizeRepositoryRequest } from "../services/security/repositoryRequestGuard.js";
import { authorizeSessionRepository } from "../services/sessions/authorizedSessionRepository.js";
import { validatePublishedRepositoryCheckout } from "../services/repository/ownershipGuard.js";

const LegacyCitationSchema = z
  .object({
    filePath: FilePathSchema,
    startLine: z.number().int(),
    endLine: z.number().int(),
    snippet: z.string(),
  })
  .refine((c) => c.endLine >= c.startLine, {
    message: "endLine must be >= startLine",
  });

const GroundedCitationSchema = z
  .object({
    repositoryId: RepositoryIdSchema,
    relativeFilePath: FilePathSchema,
    language: z.string().min(1),
    chunkId: z.string().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    retrievalType: z.enum(["semantic", "keyword", "symbol", "graph", "hybrid", "file-search"]),
    score: z.number().finite(),
    symbol: z.string().min(1).optional(),
    repositoryVersion: z.string().min(1),
  })
  .refine((citation) => citation.endLine >= citation.startLine, {
    message: "endLine must be >= startLine",
  });

const CitationSchema = z.union([LegacyCitationSchema, GroundedCitationSchema]);

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

const sessionsRouter = new Hono<{
  Variables: { requestId: string; retrievalCache: RetrievalCache };
}>();

function getSessionAccessFailureResponse(
  c: Parameters<typeof fail>[0],
  access: Extract<Awaited<ReturnType<typeof authorizeSessionRepository>>, { ok: false }>,
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
    const repoAccess = await authorizeRepositoryRequest(c, `${parsed.data.owner}/${parsed.data.repo}`, "session_create");
    if (!repoAccess.ok) return repoAccess.response;

    const session = await createNewSession({
      owner: repoAccess.repository.owner,
      repo: repoAccess.repository.repo,
      title: parsed.data.title,
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

    const ownedSessions = (await listAllSessions()).filter((session) => session.userId === user.userId);
    const authorized = await Promise.all(ownedSessions.map((session) => authorizeSessionRepository({
      sessionId: session.id,
      userId: user.userId,
      requestId: c.get("requestId"),
      operation: "session_list",
    })));
    const sessions = authorized.filter((result) => result.ok).map((result) => result.session);

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
    setRequestLogContext(c, { sessionId: id, operation: "session_get" });

    const access = await authorizeSessionRepository({
      sessionId: id,
      userId: user.userId,
      requestId: c.get("requestId"),
      operation: "session_get",
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
    setRequestLogContext(c, { sessionId: id, operation: "session_add_message" });

    const access = await authorizeSessionRepository({
      sessionId: id,
      userId: user.userId,
      requestId: c.get("requestId"),
      operation: "session_add_message",
    });

    if (!access.ok) {
      return getSessionAccessFailureResponse(c, access);
    }

    const citationMismatch = parsed.data.citations?.some((citation) =>
      "repositoryId" in citation && citation.repositoryId !== access.repository.repositoryId
    );
    if (citationMismatch) {
      return fail(c, { code: "session_repository_mismatch", message: "Citation repository does not match the session." }, 400);
    }

    const session = await addMessageToSession(id, parsed.data);

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
    setRequestLogContext(c, { sessionId: id, operation: "session_delete" });

    const access = await authorizeSessionRepository({
      sessionId: id,
      userId: user.userId,
      requestId: c.get("requestId"),
      operation: "session_delete",
    });

    if (!access.ok) {
      return getSessionAccessFailureResponse(c, access);
    }

    const removed = await removeSession(id);

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
  setRequestLogContext(c, { sessionId: id, operation: "session_ask" });
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

    const access = await authorizeSessionRepository({
      sessionId: id,
      userId: user.userId,
      requestId: c.get("requestId"),
      operation: "session_ask",
    });

    if (!access.ok) {
      return getSessionAccessFailureResponse(c, access);
    }

    const repositoryStatus = await getRepositoryIndexMetadata(
      access.repository.owner,
      access.repository.repo,
    );
    if (!repositoryStatus || repositoryStatus.status !== "indexed") {
      return fail(c, {
        code: "repository_not_ready",
        message: "Repository indexing must complete before Ask Giro can answer questions.",
      }, 409);
    }
    try {
      await validatePublishedRepositoryCheckout(access.repository);
    } catch {
      return fail(c, {
        code: "repository_unavailable",
        message: "The indexed repository checkout is unavailable. Reconnect or reindex it before asking questions.",
      }, 409);
    }

    const result = await answerSessionQuestion(id, parsed.data.question, {
      signal: getRequestDeadline(c)?.signal,
      requestId: c.get("requestId"),
      cache: c.get("retrievalCache"),
      authorizedRepository: access.repository,
    });

    if (result === "session_not_found") {
      return fail(c, { code: "session_not_found", message: "Session not found" }, 404);
    }

    return ok(c, result);
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;

    logger.error("session_ask_failed", {
      requestId: c.get("requestId"),
      sessionId: id,
      reasonCode: "session_ask_failed",
    });

    return fail(c, { code: "ask_error", message: "Ask Giro could not answer the question." }, 500);
  }
});

export default sessionsRouter;
