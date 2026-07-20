import { Hono } from "hono";
import { z } from "zod";
import { semanticSearchWithCitations } from "../services/embeddings/search.js";
import { getRequestDeadline } from "../middleware/requestTimeout.js";
import { isDeadlineExceeded } from "../runtime/deadline.js";
import { isDependencyUnavailable } from "../runtime/circuitBreaker.js";
import type { RetrievalCache } from "../services/retrieval/cache/retrievalCache.js";
import { RepositoryNameSchema, RepositoryOwnerSchema } from "../validation/repositorySchemas.js";
import { authorizeRepositoryRequest } from "../services/security/repositoryRequestGuard.js";

const SearchBody = z.object({
  query: z.string().min(1, "Query must not be empty"),
  owner: RepositoryOwnerSchema,
  repo: RepositoryNameSchema,
  limit: z.number().int().min(1).max(50).optional().default(10),
});

const searchRouter = new Hono<{
  Variables: { requestId: string; retrievalCache: RetrievalCache };
}>();

searchRouter.post("/context", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = SearchBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: "Validation failed", details: parsed.error.errors },
      400,
    );
  }

  const requestId = c.get("requestId");
  try {
    const repository = `${parsed.data.owner}/${parsed.data.repo}`;
    const access = await authorizeRepositoryRequest(c, repository, "semantic_search");
    if (!access.ok) return access.response;
    const signal = getRequestDeadline(c)?.signal;
    const repositoryVersion = await c.get("retrievalCache").repositoryVersion(access.repository.repositoryId, signal);
    const { results, citations } = await semanticSearchWithCitations(
      parsed.data.query,
      access.repository.repositoryId,
      parsed.data.limit,
      {
        signal,
        repositoryVersion,
      },
    );
    return c.json({ success: true, requestId, count: results.length, results, citations });
  } catch (err) {
    if (isDeadlineExceeded(err) || isDependencyUnavailable(err)) throw err;
    return c.json(
      {
        success: false,
        requestId,
        error: err instanceof Error ? err.message : "Search failed",
      },
      500,
    );
  }
});

export default searchRouter;
