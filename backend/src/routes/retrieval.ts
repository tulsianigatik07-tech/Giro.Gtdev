// POST /retrieval/hybrid — deterministic hybrid retrieval endpoint.

import { Hono } from "hono";
import { z } from "zod";
import { ok, fail } from "../lib/response.js";
import { logger } from "../lib/logger.js";
import { hybridSearch } from "../services/retrieval/hybridSearch.js";

type Variables = { requestId: string };

const HybridBody = z.object({
  query: z.string().min(1, "query is required"),
  owner: z.string().min(1, "owner is required"),
  repo: z.string().min(1, "repo is required"),
  limit: z.number().int().min(1).max(50).optional(),
});

const retrievalRouter = new Hono<{ Variables: Variables }>();

retrievalRouter.post("/hybrid", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = HybridBody.safeParse(body);
  if (!parsed.success) {
    return fail(
      c,
      { code: "validation_error", message: parsed.error.errors[0]?.message ?? "Invalid request" },
      400,
    );
  }

  try {
    const result = await hybridSearch(parsed.data);
    return ok(c, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    logger.error("hybrid_search_route_failed", {
      requestId: c.get("requestId"),
      message,
    });
    return fail(c, { code: "retrieval_error", message }, 500);
  }
});

export default retrievalRouter;
