import { buildRepositoryConnectFailureError } from "../../repository/cloneFailureClassifier.js";
import { cloneRepo } from "../../repository/clone.js";
import { scanRepo } from "../../repository/scanner.js";
import { analyzeRepository } from "../../repository/analyzer.js";
import { extractRepoSymbols } from "../../graph/symbolExtractor.js";
import { applyGraphUpdate } from "../../repository/graphUpdateExecutor.js";
import { buildRepositorySymbolGraph } from "../../repositoryGraph/graphBuilder.js";
import { saveRepositorySymbolGraph } from "../../repositoryGraph/runtimeRepositoryGraph.js";
import { generateRepositorySummary } from "../../repositorySummary/repositorySummary.js";
import {
  getRepositoryFileSnapshot,
  saveRepositoryFileSnapshot,
} from "../../repository/fileSnapshotStore.js";
import { buildRepositoryIndexingPlan } from "../../repository/indexingPlan.js";
import { executeIndexingPlan } from "../../repository/indexingExecutor.js";
import {
  buildIndexCleanupPlanFromIndexingPlan,
  executeIndexCleanup,
} from "../../repository/indexCleanup.js";
import {
  removeRepositorySymbolsForFiles,
  saveRepositorySymbols,
  symbolRecordsFromFileMaps,
} from "../../repository/symbolIndexStore.js";
import {
  setRepositoryIndexing,
  setRepositoryIndexed,
  setRepositoryFailed,
  type IndexedCounts,
  type SetRepositoryIndexedOptions,
} from "../../repository/indexingService.js";
import { buildRepositoryContext } from "../../context/contextBuilder.js";
import type { ApiErrorCode } from "../../../lib/apiErrors.js";
import type {
  IndexingJob,
  IndexingJobFailure,
  IndexingJobStage,
  IndexingJobStore,
} from "./indexingJobStore.js";
import type { IndexingMetricStatus, RetryMetricCategory, RetryMetricResult, TimeoutMetricCategory } from "../../../observability/metrics.js";
import { env } from "../../../config/env.js";
import { createDeadline } from "../../../runtime/deadline.js";
import { isDeadlineExceeded } from "../../../runtime/deadline.js";
import type { DependencyCircuitBreakers } from "../../../runtime/dependencyCircuitBreakers.js";
import { runtimeMetrics } from "../../../observability/metrics.js";
import { logger } from "../../../lib/logger.js";

export interface IndexingJobProgressPublisher {
  publish(job: IndexingJob): void | Promise<void>;
}

export interface RetrievalCacheInvalidator {
  invalidateRepository(repositoryId: string, reason?: string): number;
}

export interface IndexingPipelineStageProgress {
  stage: IndexingJobStage;
  progress: number;
}

export interface IndexingPipelineInput {
  job: IndexingJob;
  reportStage: (progress: IndexingPipelineStageProgress) => Promise<void>;
  signal?: AbortSignal;
  retryLogger?: { info(event: string, fields?: Record<string, unknown>): void };
  retryMetrics?: { incrementRetry(category: RetryMetricCategory, result: RetryMetricResult, attempt: number): void };
  circuitBreakers?: DependencyCircuitBreakers;
}

export interface IndexingPipelineResult {
  counts: IndexedCounts;
  indexOptions?: SetRepositoryIndexedOptions;
}

export type ExecuteIndexingPipeline = (
  input: IndexingPipelineInput,
) => Promise<IndexingPipelineResult>;

export interface IndexingJobRepositoryStore {
  markIndexing(job: IndexingJob): void | Promise<void>;
  markIndexed(job: IndexingJob, result: IndexingPipelineResult): void | Promise<void>;
  markFailed(job: IndexingJob, failure: IndexingJobFailure): void | Promise<void>;
}

export interface ProcessNextIndexingJobInput {
  workerId: string;
  jobStore: IndexingJobStore;
  repositoryStore?: IndexingJobRepositoryStore;
  executeIndexingPipeline?: ExecuteIndexingPipeline;
  logger?: IndexingJobWorkerLogger;
  metrics?: {
    incrementIndexing(status: IndexingMetricStatus): void;
    incrementTimeout?(category: TimeoutMetricCategory): void;
    incrementRetry?(category: RetryMetricCategory, result: RetryMetricResult, attempt: number): void;
  };
  circuitBreakers?: DependencyCircuitBreakers;
  progressPublisher?: IndexingJobProgressPublisher;
  retrievalCacheInvalidator?: RetrievalCacheInvalidator;
}

export interface IndexingJobWorkerLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const silentWorkerLogger: IndexingJobWorkerLogger = {
  info: () => undefined,
  error: () => undefined,
};

function jobLogFields(job: IndexingJob, workerId: string) {
  return {
    jobId: job.jobId,
    repositoryId: job.repositoryId,
    workerId,
    ...(job.createdByRequestId ? { requestId: job.createdByRequestId } : {}),
  };
}

async function publishProgressSafely(
  publisher: IndexingJobProgressPublisher | undefined,
  job: IndexingJob,
  logger: IndexingJobWorkerLogger,
  workerId: string,
): Promise<void> {
  if (!publisher) return;
  try {
    await publisher.publish(job);
  } catch {
    logger.error("indexing_progress_publish_failed", jobLogFields(job, workerId));
  }
}

export interface IndexingJobExecutionReport {
  processed: boolean;
  jobId: string | null;
  repositoryId: string | null;
  status: "idle" | "succeeded" | "failed";
  stagesCompleted: IndexingJobStage[];
  failure: IndexingJobFailure | null;
}

export const INDEXING_JOB_STAGE_PROGRESS: readonly IndexingPipelineStageProgress[] = [
  { stage: "clone", progress: 10 },
  { stage: "scan", progress: 25 },
  { stage: "structure", progress: 40 },
  { stage: "symbols", progress: 55 },
  { stage: "graph", progress: 70 },
  { stage: "chunk", progress: 80 },
  { stage: "embed", progress: 90 },
  { stage: "finalize", progress: 95 },
] as const;

const STAGE_PROGRESS_BY_STAGE = new Map(
  INDEXING_JOB_STAGE_PROGRESS.map((item) => [item.stage, item.progress]),
);

export const indexingJobRepositoryStore: IndexingJobRepositoryStore = {
  async markIndexing(job) {
    await setRepositoryIndexing(job.repositoryOwner, job.repositoryName);
  },
  async markIndexed(job, result) {
    await setRepositoryIndexed(
      job.repositoryOwner,
      job.repositoryName,
      result.counts,
      result.indexOptions,
    );
  },
  async markFailed(job) {
    await setRepositoryFailed(job.repositoryOwner, job.repositoryName);
  },
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "unknown error";
}

function sanitizedMessage(message: string): string {
  return message.split("\n")[0]?.trim() || "Indexing failed";
}

function failureFromCode(
  code: ApiErrorCode,
  message: string,
  retryable: boolean,
): IndexingJobFailure {
  return {
    code,
    message: sanitizedMessage(message),
    retryable,
  };
}

export function normalizeIndexingJobFailure(
  error: unknown,
  input: { repositoryId: string; stage: IndexingJobStage | null },
): IndexingJobFailure {
  if (input.stage === "clone") {
    const cloneError = buildRepositoryConnectFailureError(error, input.repositoryId);
    return failureFromCode(cloneError.code, cloneError.message, cloneError.retryable);
  }

  const message = errorMessage(error);
  const normalized = message.toLowerCase();

  if (input.stage === "embed") {
    if (
      normalized.includes("openai") ||
      normalized.includes("rate limit") ||
      normalized.includes("timeout") ||
      normalized.includes("unavailable")
    ) {
      return failureFromCode(
        "openai_unavailable",
        "OpenAI embedding service is unavailable.",
        true,
      );
    }
    return failureFromCode("embedding_failed", "Repository embedding failed.", true);
  }

  if (
    normalized.includes("repository store") ||
    normalized.includes("repository state") ||
    normalized.includes("mark indexed") ||
    normalized.includes("mark failed")
  ) {
    return failureFromCode("internal_error", "Repository state update failed.", false);
  }

  if (input.stage === null) {
    return failureFromCode("internal_error", "Indexing worker failed.", false);
  }

  return failureFromCode("indexing_failed", "Repository indexing failed.", true);
}

export async function executeRepositoryIndexingPipeline(
  input: IndexingPipelineInput,
): Promise<IndexingPipelineResult> {
  const { job, reportStage } = input;
  const owner = job.repositoryOwner;
  const repo = job.repositoryName;
  const repoId = job.repositoryId;

  await reportStage({ stage: "clone", progress: 10 });
  const cloneDeadline = createDeadline(env.REPOSITORY_CLONE_TIMEOUT_MS, { parentSignal: input.signal });
  let clonePath: string;
  try {
    ({ clonePath } = await cloneRepo(owner, repo, {
      deadline: cloneDeadline,
      requestId: job.createdByRequestId ?? undefined,
      jobId: job.jobId,
      logger: input.retryLogger,
      metrics: input.retryMetrics,
      circuitBreaker: input.circuitBreakers?.clone,
    }));
  } finally {
    cloneDeadline.dispose();
  }

  await reportStage({ stage: "scan", progress: 25 });
  const stats = await scanRepo(clonePath);
  const previousSnapshot = getRepositoryFileSnapshot(repoId);
  const indexingPlan = buildRepositoryIndexingPlan({
    previousSnapshot,
    currentFiles: stats.files,
  });

  await reportStage({ stage: "structure", progress: 40 });
  const analysis = await analyzeRepository(clonePath, stats);

  await reportStage({ stage: "symbols", progress: 55 });
  const symbolMaps = await extractRepoSymbols(clonePath);
  const symbolCount = symbolMaps.reduce((count, map) => count + map.symbols.length, 0);

  await reportStage({ stage: "graph", progress: 70 });
  const graph = applyGraphUpdate(owner, repo, {
    added: symbolMaps,
    modified: [],
    removed: indexingPlan.removedFiles,
  });
  const repositoryVersion = `${job.jobId}:${job.attempt}`;
  const symbolGraph = buildRepositorySymbolGraph({
    repositoryId: repoId,
    repositoryVersion,
    symbolMaps,
  });
  saveRepositorySymbolGraph(symbolGraph);
  runtimeMetrics.setSymbolGraphSize(symbolGraph.nodes.length, symbolGraph.edges.length);
  const graphLogger = input.retryLogger ?? logger;
  graphLogger.info("symbol_graph_built", {
    repositoryId: repoId,
    repositoryVersion,
    nodes: symbolGraph.nodes.length,
    edges: symbolGraph.edges.length,
  });
  generateRepositorySummary({
    repositoryId: repoId,
    repositoryVersion,
    generatedAt: new Date().toISOString(),
    scan: stats,
    analysis,
    symbolMaps,
    dependencyGraph: graph,
  }, { logger: graphLogger });

  await reportStage({ stage: "chunk", progress: 80 });
  await executeIndexingPlan({
    plan: indexingPlan,
    currentFiles: stats.files,
    analyzeFile: (file) => ({
      filePath: file.filePath,
      language: file.language,
      size: file.size,
    }),
  });

  await reportStage({ stage: "embed", progress: 90 });
  const context = await buildRepositoryContext(clonePath, repoId, {
    signal: input.signal,
    requestId: job.createdByRequestId ?? undefined,
    logger: input.retryLogger,
    metrics: input.retryMetrics,
    embeddingCircuitBreaker: input.circuitBreakers?.embedding,
    repositoryVersion,
  });

  await reportStage({ stage: "finalize", progress: 95 });
  const cleanupPlan = buildIndexCleanupPlanFromIndexingPlan(indexingPlan);
  if (cleanupPlan.cleanupRequired) {
    const cleanup = executeIndexCleanup(cleanupPlan);
    removeRepositorySymbolsForFiles(repoId, cleanup.removedFiles);
  }
  saveRepositorySymbols(repoId, symbolRecordsFromFileMaps(symbolMaps));
  saveRepositoryFileSnapshot(repoId, stats.files);

  return {
    counts: {
      chunkCount: context.totalChunks,
      fileCount: stats.totalFiles,
      symbolCount,
      graphNodeCount: graph.nodes.length,
      graphEdgeCount: graph.edges.length,
      summaryAvailable: analysis.framework !== "unknown",
    },
    indexOptions: {
      indexMode: indexingPlan.mode,
      changedFileCount: indexingPlan.totalChangedFiles,
      indexedRevision: repositoryVersion,
    },
  };
}

export async function processNextIndexingJob(
  input: ProcessNextIndexingJobInput,
): Promise<IndexingJobExecutionReport> {
  const {
    workerId,
    jobStore,
    repositoryStore = indexingJobRepositoryStore,
    executeIndexingPipeline = executeRepositoryIndexingPipeline,
    logger = silentWorkerLogger,
    metrics,
    circuitBreakers,
    progressPublisher,
    retrievalCacheInvalidator,
  } = input;

  const claimed = await jobStore.claimNextJob(workerId);
  if (!claimed) {
    return {
      processed: false,
      jobId: null,
      repositoryId: null,
      status: "idle",
      stagesCompleted: [],
      failure: null,
    };
  }
  logger.info("indexing_job_claimed", jobLogFields(claimed, workerId));

  const stagesCompleted: IndexingJobStage[] = [];
  let currentStage: IndexingJobStage | null = "pending";

  try {
    await repositoryStore.markIndexing(claimed);
    const firstStage = "clone";
    currentStage = firstStage;
    const running = await jobStore.markRunning(claimed.jobId, firstStage);
    if (!running) {
      throw new Error("Indexing job could not transition to running");
    }
    logger.info("indexing_job_started", jobLogFields(claimed, workerId));
    metrics?.incrementIndexing("started");
    await publishProgressSafely(progressPublisher, running, logger, workerId);

    const reportStage = async (progress: IndexingPipelineStageProgress) => {
      currentStage = progress.stage;
      const expected = STAGE_PROGRESS_BY_STAGE.get(progress.stage);
      const nextProgress = expected ?? progress.progress;
      const updated = await jobStore.updateProgress(
        claimed.jobId,
        nextProgress,
        progress.stage,
      );
      if (!updated) {
        throw new Error("Indexing job progress update failed");
      }
      await publishProgressSafely(progressPublisher, updated, logger, workerId);
      stagesCompleted.push(progress.stage);
    };

    const result = await executeIndexingPipeline({
      job: { ...claimed },
      reportStage,
      retryLogger: logger,
      retryMetrics: metrics?.incrementRetry ? {
        incrementRetry: (category, result, attempt) => metrics.incrementRetry!(category, result, attempt),
      } : undefined,
      circuitBreakers,
    });

    currentStage = "finalize";
    await repositoryStore.markIndexed(claimed, result);
    const succeeded = await jobStore.markSucceeded(claimed.jobId);
    if (!succeeded) {
      throw new Error("Indexing job could not be marked succeeded");
    }
    logger.info("indexing_job_succeeded", jobLogFields(claimed, workerId));
    metrics?.incrementIndexing("completed");
    try {
      retrievalCacheInvalidator?.invalidateRepository(
        claimed.repositoryId,
        "indexing_completed",
      );
    } catch {
      logger.error("retrieval_cache_invalidation_failed", jobLogFields(claimed, workerId));
    }
    await publishProgressSafely(progressPublisher, succeeded, logger, workerId);

    stagesCompleted.push("complete");
    return {
      processed: true,
      jobId: claimed.jobId,
      repositoryId: claimed.repositoryId,
      status: "succeeded",
      stagesCompleted,
      failure: null,
    };
  } catch (error) {
    if (isDeadlineExceeded(error)) {
      const timedOutStage = currentStage as IndexingJobStage | null;
      const category = timedOutStage === "clone"
        ? "clone"
        : timedOutStage === "embed"
          ? "embedding"
          : "indexing";
      metrics?.incrementTimeout?.(category);
      logger.error("indexing_stage_timeout", {
        ...jobLogFields(claimed, workerId),
        stage: timedOutStage,
      });
    }
    const failure = normalizeIndexingJobFailure(error, {
      repositoryId: claimed.repositoryId,
      stage: currentStage,
    });
    try {
      await repositoryStore.markFailed(claimed, failure);
    } catch {
      // Preserve the original indexing failure in the job/report.
    }
    const failed = await jobStore.markFailed(claimed.jobId, failure);
    logger.error("indexing_job_failed", {
      ...jobLogFields(claimed, workerId),
      failureCode: failure.code,
      retryable: failure.retryable,
    });
    metrics?.incrementIndexing("failed");
    if (failed) {
      await publishProgressSafely(progressPublisher, failed, logger, workerId);
    }
    return {
      processed: true,
      jobId: claimed.jobId,
      repositoryId: claimed.repositoryId,
      status: "failed",
      stagesCompleted,
      failure,
    };
  }
}
