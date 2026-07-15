import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createApiError, createValidationError } from "../lib/apiErrors.js";
import { fail } from "../lib/response.js";
import { setRequestLogContext } from "../middleware/requestContext.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";
import type { IndexingProgressPublisher } from "../services/indexing/events/indexingProgressPublisher.js";
import type { IndexingJobStore } from "../services/indexing/jobs/indexingJobStore.js";
import { requireRepositoryAccess } from "../services/repository/ownershipGuard.js";
import { RepositoryIdSchema } from "../validation/repositorySchemas.js";

type Variables = {
  indexingJobStore: IndexingJobStore;
  indexingProgressPublisher: IndexingProgressPublisher;
};

const repositoryIndexingEventsRoute = new Hono<{ Variables: Variables }>();

repositoryIndexingEventsRoute.get("/:repositoryId/indexing/events", async (c) => {
  const parsed = RepositoryIdSchema.safeParse(c.req.param("repositoryId"));
  if (!parsed.success) {
    return fail(c, createValidationError(parsed.error.flatten()), 400);
  }
  const repositoryId = parsed.data;
  setRequestLogContext(c, { repositoryId });

  const user = getAuthenticatedUser(c);
  if (!user) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }
  const access = requireRepositoryAccess({ repoId: repositoryId, userId: user.userId });
  if (!access.ok) {
    return fail(c, { code: access.code, message: access.message }, access.status);
  }

  let latestJob;
  try {
    latestJob = await c.get("indexingJobStore").getLatestRepositoryJob(repositoryId);
  } catch {
    return fail(c, createApiError("internal_error", "Unable to load indexing job"), 500);
  }
  if (!latestJob) {
    return fail(
      c,
      createApiError("indexing_job_not_found", "Indexing job not found"),
      404,
    );
  }
  setRequestLogContext(c, { repositoryId, jobId: latestJob.jobId });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    const subscription = c.get("indexingProgressPublisher").subscribe(
      latestJob,
      async (event) => {
        await stream.writeSSE({
          event: event.event,
          data: JSON.stringify(event.data),
        });
      },
    );
    stream.onAbort(() => subscription.unsubscribe());
    await subscription.closed;
    if (!stream.closed && !stream.aborted) await stream.close();
  });
});

export default repositoryIndexingEventsRoute;
