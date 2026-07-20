import { Hono } from "hono";

import { analyzeArchitecture } from "../services/repository/architectureAnalysisFacade.js";
import { RepositoryIdSchema } from "../validation/repositorySchemas.js";
import { authorizeRepositoryRequest } from "../services/security/repositoryRequestGuard.js";

const architectureRouter = new Hono();

architectureRouter.post("/review", async (c) => {
  const body = await c.req.json().catch(() => null);

  if (
    body === null ||
    typeof body !== "object" ||
    !("repositoryId" in body) ||
    typeof body.repositoryId !== "string" ||
    body.repositoryId.trim().length === 0
  ) {
    return c.json(
      {
        ok: false,
        error: {
          code: "BAD_REQUEST",
          message: "repositoryId is required",
        },
      },
      400,
    );
  }

  const parsedRepository = RepositoryIdSchema.safeParse(body.repositoryId);
  if (!parsedRepository.success) {
    return c.json({ ok: false, error: { code: "BAD_REQUEST", message: "repositoryId is invalid" } }, 400);
  }
  const access = await authorizeRepositoryRequest(c, parsedRepository.data, "architecture_review");
  if (!access.ok) return access.response;

  const result = analyzeArchitecture({ repositoryId: access.repository.repositoryId });

  return c.json({
    ok: true,
    data: result,
  });
});

export default architectureRouter;
