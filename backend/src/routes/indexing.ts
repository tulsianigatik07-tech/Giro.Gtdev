import { Hono } from "hono";
import { createApiError, createValidationError } from "../lib/apiErrors.js";
import { fail, ok } from "../lib/response.js";
import { setRequestLogContext } from "../middleware/requestContext.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";
import type {
  IndexingJob,
  IndexingJobFailure,
  IndexingJobStore,
} from "../services/indexing/jobs/indexingJobStore.js";
import { authorizeRepositoryRequest } from "../services/security/repositoryRequestGuard.js";
import { IndexingJobIdSchema } from "../validation/repositorySchemas.js";

type Variables = { indexingJobStore: IndexingJobStore };

const indexingRoute = new Hono<{ Variables: Variables }>();

function safeFailure(failure: IndexingJobFailure | null) {
  if (!failure) return null;
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
}

function jobStatusResponse(job: IndexingJob) {
  return {
    jobId: job.jobId,
    repositoryId: job.repositoryId,
    status: job.status,
    progress: job.progress,
    currentStage: job.currentStage,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    failure: safeFailure(job.failure),
  };
}

indexingRoute.get("/jobs/:jobId", async (c) => {
  const parsed = IndexingJobIdSchema.safeParse(c.req.param("jobId"));
  if (!parsed.success) {
    return fail(c, createValidationError(parsed.error.flatten()), 400);
  }
  setRequestLogContext(c, { jobId: parsed.data });

  const user = getAuthenticatedUser(c);
  if (!user) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }

  let job: IndexingJob | null;
  try {
    const indexingJobStore = c.get("indexingJobStore");
    job = await indexingJobStore.getJob(parsed.data);
  } catch {
    return fail(
      c,
      createApiError("internal_error", "Unable to load indexing job"),
      500,
    );
  }

  if (!job) {
    return fail(
      c,
      createApiError("indexing_job_not_found", "Indexing job not found"),
      404,
    );
  }
  setRequestLogContext(c, {
    jobId: job.jobId,
    repositoryId: job.repositoryId,
  });

  const access = await authorizeRepositoryRequest(c, job.repositoryId, "indexing_job_status");
  if (!access.ok) return access.response;
  if (
    job.ownerUserId !== user.userId ||
    job.repositoryOwner !== access.repository.owner ||
    job.repositoryName !== access.repository.repo
  ) {
    return fail(c, { code: "repo_not_owned", message: "You do not have access to this repository." }, 403);
  }

  return ok(c, jobStatusResponse(job));
});

export default indexingRoute;
