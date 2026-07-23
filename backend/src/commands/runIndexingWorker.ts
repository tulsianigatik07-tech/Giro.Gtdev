import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { env } from "../config/env.js";
import { closeSupabaseConnections, supabase } from "../lib/supabase.js";
import { flushLogs, stderrLogger } from "../lib/logger.js";
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
import {
  SupabaseIndexingWorkerContractValidator,
  validateIndexingWorkerStartup,
} from "../services/indexing/worker/indexingWorkerStartup.js";
import { isValidIndexingWorkerId } from "./processNextIndexingJob.js";
import {
  createBackendShutdown,
  installShutdownSignalHandlers,
} from "../runtime/backendShutdown.js";
import { runtimeRepositoryGraphStore } from "../services/repositoryGraph/graphStore.js";

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
    maxConsecutiveDatabaseFailures: env.INDEXING_WORKER_MAX_CONSECUTIVE_DATABASE_FAILURES,
    stallTimeoutMs: env.INDEXING_WORKER_STALL_TIMEOUT_MS,
  };
}

export async function runIndexingWorker(): Promise<0 | 1> {
  const config = buildContinuousWorkerConfig();
  const stateStore = new SupabaseIndexingWorkerStateStore(supabase);
  await runtimeRepositoryGraphStore.verify();
  const recoveredGraphBuilds = await runtimeRepositoryGraphStore.recover();
  stderrLogger.info("indexing_worker_graph_contract_validated", {
    workerId: config.workerId,
    recoveredGraphBuilds,
  });
  await validateIndexingWorkerStartup({
    config,
    stateStore,
    contractValidator: new SupabaseIndexingWorkerContractValidator(supabase),
    logger: stderrLogger,
  });
  const worker = new ContinuousIndexingWorker({
    config,
    jobStore: runtimeIndexingJobStore,
    stateStore,
    logger: stderrLogger,
    metrics: runtimeMetrics,
    onShutdownTimeout: () => undefined,
    executeNext: ({ signal, observer }) => processNextIndexingJob({
      workerId: config.workerId,
      leaseDurationMs: config.staleClaimMs,
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

  const workerRun = worker.run();
  const coordinator = createBackendShutdown({
    logger: stderrLogger,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    stopAcceptingRequests: () => undefined,
    stopIndexingWorkers: async (signal) => {
      worker.requestShutdown(signal);
      await workerRun;
    },
    closeDatabase: closeSupabaseConnections,
    flushLogs,
  });
  let resolveShutdownResult!: (result: Awaited<ReturnType<typeof coordinator.requestShutdown>>) => void;
  const shutdownResult = new Promise<Awaited<ReturnType<typeof coordinator.requestShutdown>>>((resolve) => {
    resolveShutdownResult = resolve;
  });
  const removeSignalHandlers = installShutdownSignalHandlers({
    coordinator,
    subscribe: (signal, handler) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    },
    setExitCode: (code) => {
      const existingFailure = process.exitCode !== undefined && process.exitCode !== 0;
      process.exitCode = existingFailure ? 1 : code;
    },
    forceExit: (code) => process.exit(code),
    onResult: resolveShutdownResult,
  });
  try {
    const workerCode = await workerRun;
    if (!coordinator.isShuttingDown()) return workerCode;
    const result = await shutdownResult;
    return result.exitCode === 1 ? 1 : workerCode;
  } finally {
    removeSignalHandlers();
    if (!coordinator.isShuttingDown()) {
      await closeSupabaseConnections();
      await flushLogs();
    }
  }
}

export async function validateIndexingWorkerExecutableConfig(): Promise<0> {
  const config = buildContinuousWorkerConfig();
  stderrLogger.info("indexing_worker_config_validated", {
    workerId: config.workerId,
    entrypoint: "compiled",
  });
  // Config-only preflight never opens database or realtime connections.
  // Stop the client's background auth timer without initiating network I/O.
  supabase.auth.stopAutoRefresh();
  await flushLogs();
  return 0;
}

const executablePath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;

if (executablePath === import.meta.url) {
  const executable = process.argv.slice(2).includes("--validate-config")
    ? validateIndexingWorkerExecutableConfig()
    : runIndexingWorker();
  executable
    .then((code) => {
      const existingFailure = process.exitCode !== undefined && process.exitCode !== 0;
      process.exitCode = existingFailure ? 1 : code;
    })
    .catch((error: unknown) => {
      stderrLogger.error("indexing_worker_startup_failed", {
        errorCode: "invalid_worker_runtime",
        message: error instanceof Error ? error.message : "Worker startup failed.",
      });
      process.exitCode = 1;
      supabase.auth.stopAutoRefresh();
      return flushLogs();
    });
}
