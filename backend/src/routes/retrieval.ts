// POST /retrieval/hybrid — deterministic hybrid retrieval endpoint.

import { Hono } from "hono";
import { z } from "zod";
import { ok, fail } from "../lib/response.js";
import { logger } from "../lib/logger.js";
import { createValidationError } from "../lib/apiErrors.js";
import { hybridSearch } from "../services/retrieval/hybridSearch.js";
import {
  ChunkLimitSchema,
  RepositoryNameSchema,
  RepositoryOwnerSchema,
  SearchQuerySchema,
} from "../validation/repositorySchemas.js";
import { getRequestDeadline } from "../middleware/requestTimeout.js";
import { isDeadlineExceeded } from "../runtime/deadline.js";
import { isDependencyUnavailable } from "../runtime/circuitBreaker.js";
import type { RetrievalCache } from "../services/retrieval/cache/retrievalCache.js";
import { authorizeRepositoryRequest } from "../services/security/repositoryRequestGuard.js";

type Variables = { requestId: string; retrievalCache: RetrievalCache };

const HybridBody = z.object({
  query: SearchQuerySchema.refine((value) => value.length > 0, {
    message: "query is required",
  }),
  owner: RepositoryOwnerSchema,
  repo: RepositoryNameSchema,
  limit: ChunkLimitSchema.refine((value) => value <= 50, {
    message: "limit must be less than or equal to 50",
  }).optional(),
});

const retrievalRouter = new Hono<{ Variables: Variables }>();

retrievalRouter.post("/hybrid", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = HybridBody.safeParse(body);
  if (!parsed.success) {
    return fail(
      c,
      createValidationError(parsed.error.flatten()),
      400,
    );
  }

  const access = await authorizeRepositoryRequest(c, `${parsed.data.owner}/${parsed.data.repo}`, "hybrid_retrieval");
  if (!access.ok) return access.response;

  try {
    const result = await hybridSearch({
      ...parsed.data,
      owner: access.repository.owner,
      repo: access.repository.repo,
    }, {
      signal: getRequestDeadline(c)?.signal,
      cache: c.get("retrievalCache"),
    });
    return ok(c, {
      ...result,
      results: result.results.map(({
        primaryQueryMatch: _primaryQueryMatch,
        queryExpansionMatch: _queryExpansionMatch,
        stitchedNeighborCount: _stitchedNeighborCount,
        ...retrievalResult
      }) => retrievalResult),
    });
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error("hybrid_search_route_failed", {
      requestId: c.get("requestId"),
      message,
    });
    return fail(c, { code: "retrieval_error", message }, 500);
  }
});

export default retrievalRouter;
