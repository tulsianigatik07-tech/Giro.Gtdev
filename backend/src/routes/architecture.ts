import { Hono } from "hono";

import { analyzeArchitecture } from "../services/repository/architectureAnalysisFacade.js";

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

  const result = analyzeArchitecture({
    repositoryId: body.repositoryId.trim(),
  });

  return c.json({
    ok: true,
    data: result,
  });
});

export default architectureRouter;