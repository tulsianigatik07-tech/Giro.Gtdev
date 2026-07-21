import type { IndexingJob, SupervisedIndexingJobStore } from "./indexingJobStore.js";
import { parseTraceparent } from "../../../observability/tracing.js";

export interface IndexingJobRecoveryLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface StartupRecoveryOptions {
  jobStore: SupervisedIndexingJobStore;
  logger: IndexingJobRecoveryLogger;
  leaseDurationMs: number;
  retryDelayMs: number;
  now?: () => Date;
}

export interface StartupRecoveryReport {
  unfinishedJobs: number;
  runningJobs: number;
  recoveredJobs: number;
  retriedJobs: number;
  permanentFailures: number;
}

function correlationFields(job: IndexingJob): Record<string, unknown> {
  const trace = parseTraceparent(job.createdByTraceparent);
  return {
    jobId: job.jobId,
    repositoryId: job.repositoryId,
    attempt: job.attempt,
    ...(job.createdByRequestId ? { requestId: job.createdByRequestId } : {}),
    ...(trace ? { traceId: trace.traceId } : {}),
  };
}

export async function recoverIndexingJobsOnStartup(
  options: StartupRecoveryOptions,
): Promise<StartupRecoveryReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  options.logger.info("indexing_recovery_started", {
    source: "backend_startup",
    leaseExpiresBefore: startedAt.toISOString(),
  });

  const [queued, claimed, running] = await Promise.all([
    options.jobStore.listJobs({ status: "queued" }),
    options.jobStore.listJobs({ status: "claimed" }),
    options.jobStore.listJobs({ status: "running" }),
  ]);
  const recovered = await options.jobStore.recoverStaleJobs({
    staleBefore: new Date(startedAt.getTime() - options.leaseDurationMs).toISOString(),
    leaseExpiresBefore: startedAt.toISOString(),
    retryDelayMs: options.retryDelayMs,
  });

  let retriedJobs = 0;
  let permanentFailures = 0;
  for (const job of recovered) {
    options.logger.info("indexing_abandoned_lease_recovered", {
      source: "backend_startup",
      status: job.status,
      ...correlationFields(job),
    });
    if (job.status === "queued") {
      retriedJobs += 1;
      options.logger.info("indexing_job_retry", {
        source: "backend_startup",
        reason: "abandoned_lease",
        retryDelayMs: options.retryDelayMs,
        ...correlationFields(job),
      });
    } else {
      permanentFailures += 1;
      options.logger.error("indexing_job_permanent_failure", {
        source: "backend_startup",
        failureCode: job.failure?.code ?? "abandoned_lease",
        ...correlationFields(job),
      });
    }
  }

  const report = {
    unfinishedJobs: queued.length + claimed.length + running.length,
    runningJobs: running.length,
    recoveredJobs: recovered.length,
    retriedJobs,
    permanentFailures,
  };
  options.logger.info("indexing_recovery_completed", {
    source: "backend_startup",
    ...report,
    durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
  });
  return report;
}
