import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { env } from "../config/env.js";
import { stderrLogger } from "../lib/logger.js";
import { runOneShotWorkerRuntime } from "../runtime/oneShotWorkerRuntime.js";

import type {
  IndexingJobFailure,
  IndexingJobStore,
} from "../services/indexing/jobs/indexingJobStore.js";
import {
  indexingJobRepositoryStore,
  processNextIndexingJob,
  type ExecuteIndexingPipeline,
  type IndexingJobRepositoryStore,
  type IndexingJobWorkerLogger,
} from "../services/indexing/jobs/indexingJobWorker.js";
import { runtimeIndexingJobStore } from "../services/indexing/jobs/runtimeIndexingJobStore.js";
import { runtimeMetrics, type IndexingMetricStatus } from "../observability/metrics.js";

const COMMAND_NAME = "indexing:work-once" as const;
const DEFAULT_WORKER_ID = "manual-worker";
const MAX_WORKER_ID_LENGTH = 64;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ProcessNextIndexingJobCommandResult {
  command: typeof COMMAND_NAME;
  processed: boolean;
  status: "idle" | "succeeded" | "failed";
  jobId: string | null;
  repositoryId: string | null;
  failure: IndexingJobFailure | null;
}

export interface RunProcessNextIndexingJobCommandInput {
  workerId: string;
  jobStore: IndexingJobStore;
  repositoryStore: IndexingJobRepositoryStore;
  executeIndexingPipeline?: ExecuteIndexingPipeline;
  writeOutput: (output: string) => void;
  logger?: IndexingJobWorkerLogger;
  metrics?: { incrementIndexing(status: IndexingMetricStatus): void };
}

function safeFailure(failure: IndexingJobFailure | null): IndexingJobFailure | null {
  if (!failure) return null;
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
}

function internalFailure(message: string): ProcessNextIndexingJobCommandResult {
  return {
    command: COMMAND_NAME,
    processed: false,
    status: "failed",
    jobId: null,
    repositoryId: null,
    failure: {
      code: "internal_error",
      message,
      retryable: false,
    },
  };
}

export function isValidIndexingWorkerId(workerId: string): boolean {
  return (
    workerId.length > 0 &&
    workerId.length <= MAX_WORKER_ID_LENGTH &&
    WORKER_ID_PATTERN.test(workerId) &&
    !workerId.includes("..")
  );
}

export function resolveIndexingWorkerId(
  args: readonly string[],
  environmentWorkerId: string | undefined,
): string {
  if (args.length === 0) return environmentWorkerId ?? DEFAULT_WORKER_ID;

  if (args.length === 2 && args[0] === "--worker-id") {
    return args[1] ?? "";
  }

  if (args.length === 1 && args[0]?.startsWith("--worker-id=")) {
    return args[0].slice("--worker-id=".length);
  }

  return "";
}

export function getProcessNextIndexingJobCommandExitCode(
  result: ProcessNextIndexingJobCommandResult,
): 0 | 1 {
  return result.status === "failed" ? 1 : 0;
}

export async function runProcessNextIndexingJobCommand(
  input: RunProcessNextIndexingJobCommandInput,
): Promise<ProcessNextIndexingJobCommandResult> {
  let result: ProcessNextIndexingJobCommandResult;

  if (!isValidIndexingWorkerId(input.workerId)) {
    result = internalFailure("Invalid indexing worker ID.");
  } else {
    try {
      const report = await processNextIndexingJob({
        workerId: input.workerId,
        jobStore: input.jobStore,
        repositoryStore: input.repositoryStore,
        executeIndexingPipeline: input.executeIndexingPipeline,
        logger: input.logger,
        metrics: input.metrics,
      });
      result = {
        command: COMMAND_NAME,
        processed: report.processed,
        status: report.status,
        jobId: report.jobId,
        repositoryId: report.repositoryId,
        failure: safeFailure(report.failure),
      };
    } catch {
      result = internalFailure("Indexing worker command failed.");
    }
  }

  input.writeOutput(JSON.stringify(result));
  return result;
}

async function runExecutable(): Promise<void> {
  const workerId = resolveIndexingWorkerId(
    process.argv.slice(2),
    env.INDEXING_WORKER_ID,
  );

  await runOneShotWorkerRuntime({
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    logger: stderrLogger,
    runCommand: (writeOutput) =>
      runProcessNextIndexingJobCommand({
        workerId,
        jobStore: runtimeIndexingJobStore,
        repositoryStore: indexingJobRepositoryStore,
        writeOutput,
        logger: stderrLogger,
        metrics: runtimeMetrics,
      }),
    writeOutput: (output) => console.log(output),
    interruptedOutput: JSON.stringify(
      internalFailure("Indexing worker shutdown was forced."),
    ),
    subscribeToSignal: (signal, handler) => {
      process.on(signal, handler);
      return () => process.off(signal, handler);
    },
    setExitCode: (code) => {
      const existingFailure =
        process.exitCode !== undefined && process.exitCode !== 0;
      process.exitCode = existingFailure ? 1 : code;
    },
    forceExit: (code) => process.exit(code),
  });
}

const executablePath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;

if (executablePath === import.meta.url) {
  void runExecutable();
}
