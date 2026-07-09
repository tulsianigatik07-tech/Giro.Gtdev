// POST /context/build — chunk an already-cloned repository.
// POST /context/assemble — build AI-ready context from embedded chunks.

import { Hono } from "hono";
import { z } from "zod";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildRepositoryContext } from "../services/context/contextBuilder.js";
import { assembleEnrichedContext } from "../services/context/enrichedAssembler.js";
import { ok, fail } from "../lib/response.js";
import { logger } from "../lib/logger.js";
import {
  ChunkLimitSchema,
  RepositoryNameSchema,
  RepositoryOwnerSchema,
  SearchQuerySchema,
} from "../validation/repositorySchemas.js";

const STORAGE_PATH_GUARD = ".storage/repos";

const BuildBody = z.object({ clonePath: z.string().min(1) });

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

const contextRouter = new Hono<{ Variables: { requestId: string } }>();

contextRouter.post("/build", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = BuildBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: "Validation failed", details: parsed.error.errors },
      400,
    );
  }

  const { clonePath } = parsed.data;
  if (!clonePath.includes(STORAGE_PATH_GUARD)) {
    return c.json(
      { success: false, error: "Invalid clonePath. Must be within .storage/repos." },
      403,
    );
  }

  // Derive repository identifier from clone folder name (owner--repo)
  const folderName = path.basename(clonePath);
  const repository = folderName.replace("--", "/");

  const requestId = randomUUID();
  try {
    const data = await buildRepositoryContext(clonePath, repository);
    return c.json({ success: true, requestId, data });
  } catch (err) {
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
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
      {
        code: "validation_error",
        message: "Invalid request body",
        details: parsed.error.flatten(),
      },
      400,
    );
  }

  const { query, owner, repo, maxChars, limit } = parsed.data;
  try {
    const result = await assembleEnrichedContext({ query, owner, repo, maxChars, limit });
    return ok(c, result);
  } catch (err) {
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
      message,
    });
    return fail(c, { code: "assembly_error", message }, 500);
  }
});

export default contextRouter;
