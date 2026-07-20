import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { createApiError, createValidationError } from "../lib/apiErrors.js";
import { fail, ok } from "../lib/response.js";
import { setRequestLogContext } from "../middleware/requestContext.js";
import type { IndexingProgressPublisher } from "../services/indexing/events/indexingProgressPublisher.js";
import type { IndexingJobStore } from "../services/indexing/jobs/indexingJobStore.js";
import { authorizeRepositoryRequest } from "../services/security/repositoryRequestGuard.js";
import { getRepositorySummary } from "../services/repositorySummary/runtimeRepositorySummary.js";
import { RepositoryIdSchema } from "../validation/repositorySchemas.js";

type Variables = {
  indexingJobStore: IndexingJobStore;
  indexingProgressPublisher: IndexingProgressPublisher;
};

const repositoryIndexingEventsRoute = new Hono<{ Variables: Variables }>();

repositoryIndexingEventsRoute.get("/:repositoryId/summary", async (c) => {
  const parsed = RepositoryIdSchema.safeParse(c.req.param("repositoryId"));
  if (!parsed.success) {
    return fail(c, createValidationError(parsed.error.flatten()), 400);
  }
  const repositoryId = parsed.data;
  setRequestLogContext(c, { repositoryId });

  const access = await authorizeRepositoryRequest(c, repositoryId, "repository_summary");
  if (!access.ok) return access.response;

  let repositoryVersion: string | undefined;
  try {
    const latestJob = await c.get("indexingJobStore").getLatestRepositoryJob(repositoryId);
    if (latestJob?.status === "succeeded") {
      repositoryVersion = `${latestJob.jobId}:${latestJob.attempt}`;
      setRequestLogContext(c, { repositoryId, jobId: latestJob.jobId });
    }
  } catch {
    return fail(c, createApiError("internal_error", "Unable to load indexing job"), 500);
  }

  const summary = getRepositorySummary(repositoryId, { repositoryVersion }) ??
    getRepositorySummary(repositoryId);
  if (!summary) {
    return fail(
      c,
      createApiError("repo_not_connected", "Repository summary is not available"),
      404,
    );
  }

  return ok(c, { summary });
});

repositoryIndexingEventsRoute.get("/:repositoryId/indexing/events", async (c) => {
  const parsed = RepositoryIdSchema.safeParse(c.req.param("repositoryId"));
  if (!parsed.success) {
    return fail(c, createValidationError(parsed.error.flatten()), 400);
  }
  const repositoryId = parsed.data;
  setRequestLogContext(c, { repositoryId });

  const access = await authorizeRepositoryRequest(c, repositoryId, "indexing_events");
  if (!access.ok) return access.response;

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
