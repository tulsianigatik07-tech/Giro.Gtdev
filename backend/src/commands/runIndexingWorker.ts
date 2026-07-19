import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { supabase } from "../lib/supabase.js";
import { stderrLogger } from "../lib/logger.js";
import { runtimeMetrics } from "../observability/metrics.js";
import { runtimeIndexingProgressPublisher } from "../services/indexing/events/runtimeIndexingProgressPublisher.js";
import {
  indexingJobRepositoryStore,
  processNextIndexingJob,
} from "../services/indexing/jobs/indexingJobWorker.js";
import { runtimeIndexingJobStore } from "../services/indexing/jobs/runtimeIndexingJobStore.js";
import { runtimeRetrievalCache } from "../services/retrieval/cache/runtimeRetrievalCache.js";
import { ContinuousIndexingWorker } from "../services/indexing/worker/continuousIndexingWorker.js";
import { SupabaseIndexingWorkerStateStore } from "../services/indexing/worker/indexingWorkerStateStore.js";
import { isValidIndexingWorkerId } from "./processNextIndexingJob.js";

export function buildContinuousWorkerConfig() {
  const workerId = env.INDEXING_WORKER_ID ?? "development-worker";
  if (!isValidIndexingWorkerId(workerId)) {
    throw new Error("INDEXING_WORKER_ID is invalid.");
  }
  if (env.NODE_ENV === "production" && !env.INDEXING_WORKER_ID) {
    throw new Error("INDEXING_WORKER_ID is required in production.");
  }
  return {
    workerId,
    pollIntervalMs: env.INDEXING_WORKER_POLL_INTERVAL_MS,
    idleBackoffMs: env.INDEXING_WORKER_IDLE_BACKOFF_MS,
    maxPollIntervalMs: env.INDEXING_WORKER_MAX_POLL_INTERVAL_MS,
    staleClaimMs: env.INDEXING_WORKER_STALE_CLAIM_MS,
    heartbeatMs: env.INDEXING_WORKER_HEARTBEAT_MS,
    retryBaseMs: env.INDEXING_WORKER_RETRY_BASE_MS,
    retryMaxMs: env.INDEXING_WORKER_RETRY_MAX_MS,
    shutdownTimeoutMs: env.INDEXING_WORKER_SHUTDOWN_TIMEOUT_MS,
  };
}

export async function runIndexingWorker(): Promise<0 | 1> {
  const config = buildContinuousWorkerConfig();
  const worker = new ContinuousIndexingWorker({
    config,
    jobStore: runtimeIndexingJobStore,
    stateStore: new SupabaseIndexingWorkerStateStore(supabase),
    logger: stderrLogger,
    onShutdownTimeout: () => process.exit(1),
    executeNext: ({ signal, observer }) => processNextIndexingJob({
      workerId: config.workerId,
      jobStore: runtimeIndexingJobStore,
      repositoryStore: indexingJobRepositoryStore,
      logger: stderrLogger,
      metrics: runtimeMetrics,
      progressPublisher: runtimeIndexingProgressPublisher,
      retrievalCacheInvalidator: runtimeRetrievalCache,
      signal,
      observer,
    }),
  });

  const onSigint = () => worker.requestShutdown("SIGINT");
  const onSigterm = () => worker.requestShutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await worker.run();
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

const executablePath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;

if (executablePath === import.meta.url) {
  runIndexingWorker()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      stderrLogger.error("indexing_worker_startup_failed", {
        errorCode: "invalid_worker_runtime",
        message: error instanceof Error ? error.message : "Worker startup failed.",
      });
      process.exitCode = 1;
    });
}
