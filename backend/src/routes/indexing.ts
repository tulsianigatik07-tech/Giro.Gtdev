import { Hono } from "hono";
import { createApiError, createValidationError } from "../lib/apiErrors.js";
import { fail, ok } from "../lib/response.js";
import { getAuthenticatedUser } from "../services/auth/authContext.js";
import { indexingJobStore } from "../services/indexing/jobs/memoryIndexingJobStore.js";
import type { IndexingJob, IndexingJobFailure } from "../services/indexing/jobs/indexingJobStore.js";
import { requireRepositoryAccess } from "../services/repository/ownershipGuard.js";
import { IndexingJobIdSchema } from "../validation/repositorySchemas.js";

const indexingRoute = new Hono();

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

  const user = getAuthenticatedUser(c);
  if (!user) {
    return fail(c, { code: "unauthorized", message: "Authentication required" }, 401);
  }

  let job: IndexingJob | null;
  try {
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

  const access = requireRepositoryAccess({
    repoId: job.repositoryId,
    userId: user.userId,
  });
  if (!access.ok) {
    return fail(c, { code: access.code, message: access.message }, access.status);
  }

  return ok(c, jobStatusResponse(job));
});

export default indexingRoute;
