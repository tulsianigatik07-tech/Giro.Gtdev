// POST /context/build — chunk an already-cloned repository.
// POST /context/assemble — build AI-ready context from embedded chunks.

import { Hono } from "hono";
import { z } from "zod";
import { buildRepositoryContext } from "../services/context/contextBuilder.js";
import { assembleEnrichedContext } from "../services/context/enrichedAssembler.js";
import { ok, fail } from "../lib/response.js";
import { logger } from "../lib/logger.js";
import { createValidationError } from "../lib/apiErrors.js";
import {
  ChunkLimitSchema,
  RepositoryNameSchema,
  RepositoryOwnerSchema,
  SearchQuerySchema,
  RepositoryIdSchema,
} from "../validation/repositorySchemas.js";
import { getRequestDeadline } from "../middleware/requestTimeout.js";
import { isDeadlineExceeded } from "../runtime/deadline.js";
import { isDependencyUnavailable } from "../runtime/circuitBreaker.js";
import type { RetrievalCache } from "../services/retrieval/cache/retrievalCache.js";
import { authorizeRepositoryRequest } from "../services/security/repositoryRequestGuard.js";
import { validateRepositoryCheckout } from "../services/security/repositoryPaths.js";

const BuildBody = z.object({ repositoryId: RepositoryIdSchema });

const AssembleBody = z.object({
  query: SearchQuerySchema.refine((value) => value.length > 0, {
    message: "query is required",
  }),
  owner: RepositoryOwnerSchema,
  repo: RepositoryNameSchema,
  maxChars: z.number().int().min(1000).max(100000).optional().default(16000),
  limit: ChunkLimitSchema.refine((value) => value <= 50, {
    message: "limit must be less than or equal to 50",
  }).optional().default(25),
});

const contextRouter = new Hono<{
  Variables: { requestId: string; retrievalCache: RetrievalCache };
}>();

contextRouter.post("/build", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = BuildBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: "Validation failed", details: parsed.error.errors },
      400,
    );
  }

  const requestId = c.get("requestId");
  const access = await authorizeRepositoryRequest(c, parsed.data.repositoryId, "context_build");
  if (!access.ok) return access.response;
  if (!access.repository.indexedRevision) {
    return fail(c, { code: "repository_not_ready", message: "Repository indexing is not ready." }, 409);
  }
  try {
    const checkout = await validateRepositoryCheckout(access.repository.repositoryId, { mustExist: true });
    const data = await buildRepositoryContext(checkout, access.repository.repositoryId, {
      signal: getRequestDeadline(c)?.signal,
      repositoryVersion: access.repository.indexedRevision,
    });
    return c.json({ success: true, requestId, data });
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    return c.json(
      {
        success: false,
        error: "Repository context build failed",
        requestId,
      },
      500,
    );
  }
});

contextRouter.post("/assemble", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = AssembleBody.safeParse(body);
  if (!parsed.success) {
    return fail(
      c,
      createValidationError(parsed.error.flatten()),
      400,
    );
  }

  const { query, owner, repo, maxChars, limit } = parsed.data;
  const access = await authorizeRepositoryRequest(c, `${owner}/${repo}`, "context_assemble");
  if (!access.ok) return access.response;
  try {
    const result = await assembleEnrichedContext(
      { query, owner: access.repository.owner, repo: access.repository.repo, maxChars, limit },
      {
        signal: getRequestDeadline(c)?.signal,
        cache: c.get("retrievalCache"),
        authorizedRepository: access.repository,
      },
    );
    const { _confidenceBudgetDropCount, ...publicResult } = result;
    return ok(c, {
      ...publicResult,
      context: result.context.map(({
        primaryQueryMatch: _primaryQueryMatch,
        queryExpansionMatch: _queryExpansionMatch,
        stitchedNeighborCount: _stitchedNeighborCount,
        ...chunk
      }) => chunk),
    });
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    const message = err instanceof Error ? err.message : "Context assembly failed";
    if (message.includes("not connected")) {
      return fail(
        c,
        {
          code: "repo_not_connected",
          message: "Repository not connected. Call POST /repos/connect first.",
        },
        404,
      );
    }
    logger.error("context_assemble_failed", {
      requestId: c.get("requestId"),
      repositoryId: access.repository.repositoryId,
      reasonCode: "context_assembly_failed",
    });
    return fail(c, { code: "assembly_error", message: "Context assembly failed." }, 500);
  }
});

export default contextRouter;
