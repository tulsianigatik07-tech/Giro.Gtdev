import { buildRepositoryConnectFailureError } from "../../repository/cloneFailureClassifier.js";
import { cloneRepo } from "../../repository/clone.js";
import { scanRepo } from "../../repository/scanner.js";
import { analyzeRepository } from "../../repository/analyzer.js";
import { extractRepoSymbols } from "../../graph/symbolExtractor.js";
import { buildDependencyGraph, computeStats, detectInsights } from "../../graph/graphBuilder.js";
import { buildRepositorySymbolGraph } from "../../repositoryGraph/graphBuilder.js";
import { buildRepositoryArchitectureSummary } from "../../repositorySummary/summaryBuilder.js";
import { buildRepositoryIndexingPlan } from "../../repository/indexingPlan.js";
import { executeIndexingPlan } from "../../repository/indexingExecutor.js";
import { symbolRecordsFromFileMaps } from "../../repository/symbolIndexStore.js";
import {
  runtimeRepositoryArtifactStore,
  type RepositoryArtifactStore,
} from "../../repository/artifacts/repositoryArtifactStore.js";
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
import { INDEXING_JOB_LEASE_CONFLICT, indexingJobClaim } from "./indexingJobStore.js";
import type { IndexingMetricStatus, RetryMetricCategory, RetryMetricResult, TimeoutMetricCategory } from "../../../observability/metrics.js";
import { env } from "../../../config/env.js";
import { createDeadline } from "../../../runtime/deadline.js";
import { isDeadlineExceeded, waitForDeadline } from "../../../runtime/deadline.js";
import type { DependencyCircuitBreakers } from "../../../runtime/dependencyCircuitBreakers.js";
import { runtimeMetrics } from "../../../observability/metrics.js";
import { currentLogContext, logger, runWithLogContext } from "../../../lib/logger.js";
import {
  createTraceContext,
  currentTraceContext,
  parseTraceparent,
  runWithTraceContext,
} from "../../../observability/tracing.js";
import {
  runtimeRepositorySnapshotStore,
  type RepositorySnapshotStore,
} from "../snapshots/repositorySnapshotStore.js";
import type { RepositoryRecord, RepositoryStore } from "../../repository/store/repositoryStore.js";
import {
  collectRepositoryCheckouts,
  refreshPreviousCheckoutReadLease,
  removeUnpublishedRepositoryCheckout,
  sealRepositoryCheckout,
} from "../../repository/revisionCheckouts.js";
import { repositoryStore as runtimeRepositoryStore } from "../../repository/store/runtimeRepositoryStore.js";
import { normalizeGitHubRepositoryReference, normalizeRepositoryId } from "../../security/repositoryIdentity.js";
import type { TrustedRepositoryCheckoutPath } from "../../security/repositoryPaths.js";
import { recordRepositoryLifecycleEvent } from "../../repository/repositoryLifecycleEvents.js";
import { BranchNameSchema } from "../../../validation/repositorySchemas.js";
import {
  isRepositoryQuotaError,
  RepositoryQuotaError,
  runtimeRepositoryQuotas,
  type RepositoryQuotas,
} from "../../repository/quotas/repositoryQuota.js";
import {
  runtimeEmbeddingIndexStore,
  type EmbeddingIndexStore,
} from "../../embeddings/indexStore.js";
import { runtimeEmbeddingIndexConfiguration } from "../../embeddings/indexVersion.js";

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
  snapshotStore?: RepositorySnapshotStore;
  artifactStore?: RepositoryArtifactStore;
  embeddingIndexStore?: EmbeddingIndexStore;
  quotas?: RepositoryQuotas;
}

export interface IndexingPipelineResult {
  counts: IndexedCounts;
  indexOptions?: SetRepositoryIndexedOptions;
  publicationHandled?: boolean;
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
  leaseDurationMs?: number;
  jobStore: IndexingJobStore;
  repositoryStore?: IndexingJobRepositoryStore;
  repositoryAuthorizationStore?: Pick<RepositoryStore, "getRepository">;
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
  signal?: AbortSignal;
  quotas?: RepositoryQuotas;
  observer?: {
    onClaimed?(job: IndexingJob): void | Promise<void>;
    onStarted?(job: IndexingJob): void | Promise<void>;
    onProgress?(job: IndexingJob): void | Promise<void>;
  };
}

export type WorkerRepositoryAuthorization = Readonly<{
  repository: RepositoryRecord;
  repositoryId: string;
  owner: string;
  repo: string;
  ownerUserId: string;
}>;

export async function authorizeIndexingJob(
  job: IndexingJob,
  store: Pick<RepositoryStore, "getRepository">,
): Promise<WorkerRepositoryAuthorization> {
  let jobIdentity;
  let urlIdentity;
  try {
    jobIdentity = normalizeRepositoryId(job.repositoryId);
    urlIdentity = normalizeGitHubRepositoryReference(job.repositoryUrl);
  } catch {
    throw new Error("Worker job/repository mismatch: malformed repository identity.");
  }
  const repository = await store.getRepository(jobIdentity.repositoryId);
  const activeLifecycleStates = new Set(["connected", "indexing", "indexed", "failed", "stale"]);
  if (
    !repository ||
    !repository.ownerUserId ||
    repository.repositoryId !== jobIdentity.repositoryId ||
    repository.owner !== jobIdentity.owner ||
    repository.repo !== jobIdentity.repo ||
    job.repositoryOwner !== repository.owner ||
    job.repositoryName !== repository.repo ||
    job.ownerUserId !== repository.ownerUserId ||
    urlIdentity.repositoryId !== repository.repositoryId ||
    (job.branch !== null && !BranchNameSchema.safeParse(job.branch).success) ||
    !activeLifecycleStates.has(repository.status)
  ) {
    throw new Error("Worker job/repository mismatch: durable repository validation failed.");
  }
  return Object.freeze({
    repository,
    repositoryId: repository.repositoryId,
    owner: repository.owner,
    repo: repository.repo,
    ownerUserId: repository.ownerUserId,
  });
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
  const trace = currentTraceContext();
  return {
    jobId: job.jobId,
    repositoryId: job.repositoryId,
    workerId,
    attempt: job.attempt,
    ...(job.createdByRequestId ? { requestId: job.createdByRequestId } : {}),
    ...(trace ? { traceId: trace.traceId, spanId: trace.spanId } : {}),
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
    if (result.publicationHandled) return;
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
  if (isRepositoryQuotaError(error)) {
    return {
      code: "repository_quota_exceeded",
      message: error.message,
      retryable: false,
      details: { reason: error.reason, limit: error.limit, observed: error.observed },
    };
  }
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
  if (normalized.includes("worker job/repository mismatch")) {
    return failureFromCode("internal_error", "Indexing job repository validation failed.", false);
  }

  if (
    normalized.includes("invalid repository") ||
    normalized.includes("unsupported repository") ||
    normalized.includes("invalid repository input")
  ) {
    return failureFromCode("invalid_repo_url", "Repository input is invalid.", false);
  }
  if (
    normalized.includes("unauthorized") ||
    normalized.includes("authorization failed") ||
    normalized.includes("permission denied")
  ) {
    return failureFromCode("unauthorized", "Repository authorization failed.", false);
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
  const snapshotStore = input.snapshotStore ?? runtimeRepositorySnapshotStore;
  const artifactStore = input.artifactStore ?? runtimeRepositoryArtifactStore;
  const embeddingIndexStore = input.embeddingIndexStore ?? runtimeEmbeddingIndexStore;
  const quotas = input.quotas ?? runtimeRepositoryQuotas;

  await reportStage({ stage: "clone", progress: 10 });
  const cloneDeadline = createDeadline(env.REPOSITORY_CLONE_TIMEOUT_MS, { parentSignal: input.signal });
  let cloned: Awaited<ReturnType<typeof cloneRepo>>;
  try {
    cloned = await cloneRepo(owner, repo, {
      deadline: cloneDeadline,
      requestId: job.createdByRequestId ?? undefined,
      jobId: job.jobId,
      logger: input.retryLogger,
      metrics: input.retryMetrics,
      circuitBreaker: input.circuitBreakers?.clone,
      branch: job.branch,
      quotas,
    });
  } finally {
    cloneDeadline.dispose();
  }

  const clonePath = cloned.clonePath;
  const revision = cloned.commitSha;
  const identity = {
    repositoryId: repoId,
    revision,
    branch: cloned.branch,
    jobId: job.jobId,
    workerId: job.claimedBy ?? "",
    claimToken: job.claimToken ?? "",
  };
  input.signal?.throwIfAborted();
  const staged = await snapshotStore.begin(identity, input.signal);
  const embeddingConfiguration = runtimeEmbeddingIndexConfiguration(repoId, revision);
  const embeddingStaged = await embeddingIndexStore.begin(identity, embeddingConfiguration, input.signal);
  if (staged.alreadyPublished && staged.counts && embeddingStaged.alreadyPublished) {
    const indexOptions = {
      indexMode: "incremental" as const,
      changedFileCount: 0,
      indexedRevision: revision,
    };
    await snapshotStore.publish({
      ...identity,
      counts: staged.counts,
      embeddingVersion: embeddingConfiguration.embeddingVersion,
      indexOptions,
      ownerUserId: job.ownerUserId,
      maxIndexedRepositoriesPerUser: quotas.maxIndexedRepositoriesPerUser,
      maxStorageBytesPerUser: quotas.maxStorageBytesPerUser,
    }, input.signal);
    return { counts: staged.counts, indexOptions, publicationHandled: true };
  }

  try {
    if (staged.alreadyPublished && staged.counts) {
      await reportStage({ stage: "chunk", progress: 80 });
      input.signal?.throwIfAborted();
      await reportStage({ stage: "embed", progress: 90 });
      const context = await buildRepositoryContext(clonePath, repoId, {
        signal: input.signal,
        requestId: job.createdByRequestId ?? undefined,
        logger: input.retryLogger,
        metrics: input.retryMetrics,
        embeddingCircuitBreaker: input.circuitBreakers?.embedding,
        repositoryVersion: revision,
        embeddingVersion: embeddingConfiguration.embeddingVersion,
        embeddingIndexStore,
      });
      await reportStage({ stage: "finalize", progress: 95 });
      input.signal?.throwIfAborted();
      await embeddingIndexStore.validate(
        identity,
        embeddingConfiguration.embeddingVersion,
        context.totalChunks,
        input.signal,
      );
      const counts = { ...staged.counts, chunkCount: context.totalChunks };
      const indexOptions = {
        indexMode: "full" as const,
        changedFileCount: staged.counts.fileCount,
        indexedRevision: revision,
      };
      await snapshotStore.publish({
        ...identity,
        counts,
        embeddingVersion: embeddingConfiguration.embeddingVersion,
        indexOptions,
        ownerUserId: job.ownerUserId,
        maxIndexedRepositoriesPerUser: quotas.maxIndexedRepositoriesPerUser,
        maxStorageBytesPerUser: quotas.maxStorageBytesPerUser,
      }, input.signal);
      return { counts, indexOptions, publicationHandled: true };
    }
    return await buildAndPublishRepositorySnapshot({
      ...input,
      job,
      clonePath,
      revision,
      identity,
      snapshotStore,
      artifactStore,
      embeddingIndexStore,
      embeddingConfiguration,
    });
  } catch (error) {
    try {
      await embeddingIndexStore.discard(identity, embeddingConfiguration.embeddingVersion);
    } catch {
      logger.error("embedding_index_rollback_failed", {
        repositoryId: repoId,
        revision,
        embeddingVersion: embeddingConfiguration.embeddingVersion,
        jobId: job.jobId,
      });
    }
    try {
      await snapshotStore.discard(identity);
    } catch {
      logger.error("repository_snapshot_rollback_failed", {
        repositoryId: repoId,
        revision,
        jobId: job.jobId,
      });
    }
    try {
      await removeUnpublishedRepositoryCheckout(repoId, revision);
    } catch {
      logger.error("repository_quota_checkout_cleanup_failed", {
        repositoryId: repoId,
        revision,
        jobId: job.jobId,
      });
    }
    throw error;
  }
}

async function buildAndPublishRepositorySnapshot(input: IndexingPipelineInput & {
  clonePath: TrustedRepositoryCheckoutPath;
  revision: string;
  identity: Parameters<RepositorySnapshotStore["begin"]>[0];
  snapshotStore: RepositorySnapshotStore;
  artifactStore: RepositoryArtifactStore;
  embeddingIndexStore: EmbeddingIndexStore;
  embeddingConfiguration: ReturnType<typeof runtimeEmbeddingIndexConfiguration>;
}): Promise<IndexingPipelineResult> {
  const {
    job,
    reportStage,
    clonePath,
    revision,
    identity,
    snapshotStore,
    artifactStore,
    embeddingIndexStore,
    embeddingConfiguration,
  } = input;
  const owner = job.repositoryOwner;
  const repo = job.repositoryName;
  const repoId = job.repositoryId;
  const quotas = input.quotas ?? runtimeRepositoryQuotas;

  await reportStage({ stage: "scan", progress: 25 });
  input.signal?.throwIfAborted();
  const stats = await scanRepo(clonePath, quotas, input.signal);
  const previousSnapshot = (await artifactStore.loadCurrent(repoId, input.signal))?.fileSnapshot ?? null;
  const indexingPlan = buildRepositoryIndexingPlan({
    previousSnapshot,
    currentFiles: stats.files,
  });

  await reportStage({ stage: "structure", progress: 40 });
  input.signal?.throwIfAborted();
  const analysis = await analyzeRepository(clonePath, stats);

  await reportStage({ stage: "symbols", progress: 55 });
  input.signal?.throwIfAborted();
  const symbolMaps = await extractRepoSymbols(clonePath);
  const symbolCount = symbolMaps.reduce((count, map) => count + map.symbols.length, 0);

  await reportStage({ stage: "graph", progress: 70 });
  input.signal?.throwIfAborted();
  const builtGraph = buildDependencyGraph(symbolMaps);
  const graph = {
    ...builtGraph,
    stats: computeStats(builtGraph.nodes, builtGraph.edges),
    insights: detectInsights(builtGraph.nodes, builtGraph.edges),
  };
  const repositoryVersion = revision;
  const symbolGraph = buildRepositorySymbolGraph({
    repositoryId: repoId,
    repositoryVersion,
    symbolMaps,
  });
  const graphLogger = input.retryLogger ?? logger;
  graphLogger.info("symbol_graph_built", {
    repositoryId: repoId,
    repositoryVersion,
    nodes: symbolGraph.nodes.length,
    edges: symbolGraph.edges.length,
  });
  const summary = buildRepositoryArchitectureSummary({
    repositoryId: repoId,
    repositoryVersion,
    generatedAt: new Date().toISOString(),
    scan: stats,
    analysis,
    symbolMaps,
    dependencyGraph: graph,
  });
  await snapshotStore.saveSummary(identity, summary, input.signal);

  await reportStage({ stage: "chunk", progress: 80 });
  input.signal?.throwIfAborted();
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
  input.signal?.throwIfAborted();
  const context = await buildRepositoryContext(clonePath, repoId, {
    signal: input.signal,
    requestId: job.createdByRequestId ?? undefined,
    logger: input.retryLogger,
    metrics: input.retryMetrics,
    embeddingCircuitBreaker: input.circuitBreakers?.embedding,
    repositoryVersion,
    embeddingVersion: embeddingConfiguration.embeddingVersion,
    embeddingIndexStore,
  });

  await reportStage({ stage: "finalize", progress: 95 });
  input.signal?.throwIfAborted();
  await embeddingIndexStore.validate(
    identity,
    embeddingConfiguration.embeddingVersion,
    context.totalChunks,
    input.signal,
  );
  const counts = {
      chunkCount: context.totalChunks,
      fileCount: stats.totalFiles,
      symbolCount,
      graphNodeCount: graph.nodes.length,
      graphEdgeCount: graph.edges.length,
      summaryAvailable: analysis.framework !== "unknown",
    };
  const indexOptions = {
      indexMode: indexingPlan.mode,
      changedFileCount: indexingPlan.totalChangedFiles,
      indexedRevision: repositoryVersion,
    };

  const snapshotTimestamp = new Date().toISOString();
  await artifactStore.stage(identity, {
    graph: symbolGraph,
    summary,
    graphSource: symbolMaps,
    symbolIndex: symbolRecordsFromFileMaps(symbolMaps),
    fileSnapshot: {
      updatedAt: snapshotTimestamp,
      files: stats.files.map((file) => ({
        filePath: file.filePath,
        size: file.size,
        language: file.language,
        lastSeenAt: snapshotTimestamp,
      })),
    },
  }, quotas.maxArtifactBytes, input.signal);
  input.signal?.throwIfAborted();
  await sealRepositoryCheckout(clonePath);
  await snapshotStore.publish({
    ...identity,
    counts,
    embeddingVersion: embeddingConfiguration.embeddingVersion,
    indexOptions,
    ownerUserId: job.ownerUserId,
    repositoryStorageBytes: stats.repositoryBytes ?? stats.indexedTextBytes ?? 0,
    maxIndexedRepositoriesPerUser: quotas.maxIndexedRepositoriesPerUser,
    maxStorageBytesPerUser: quotas.maxStorageBytesPerUser,
  }, input.signal);
  try {
    await refreshPreviousCheckoutReadLease(repoId);
  } catch (error: unknown) {
    logger.warn("repository_checkout_read_lease_refresh_failed", {
      repositoryId: repoId,
      revision,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
  try {
    await artifactStore.collect(repoId);
  } catch (error: unknown) {
    logger.warn("repository_artifact_gc_failed", {
      repositoryId: repoId,
      revision,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
  try {
    await collectRepositoryCheckouts(repoId);
  } catch (error: unknown) {
    logger.warn("repository_checkout_gc_failed", {
      repositoryId: repoId,
      revision,
      message: error instanceof Error ? error.message : "unknown",
    });
  }
  runtimeMetrics.setSymbolGraphSize(symbolGraph.nodes.length, symbolGraph.edges.length);

  return {
    counts,
    indexOptions,
    publicationHandled: true,
  };
}

export async function processNextIndexingJob(
  input: ProcessNextIndexingJobInput,
): Promise<IndexingJobExecutionReport> {
  const {
    workerId,
    leaseDurationMs,
    jobStore,
    repositoryStore = indexingJobRepositoryStore,
    repositoryAuthorizationStore = runtimeRepositoryStore,
    executeIndexingPipeline = executeRepositoryIndexingPipeline,
    logger = silentWorkerLogger,
    metrics,
    circuitBreakers,
    progressPublisher,
    retrievalCacheInvalidator,
    signal,
    observer,
    quotas = runtimeRepositoryQuotas,
  } = input;

  const claimed = await jobStore.claimNextJob(workerId, leaseDurationMs);
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
  const workerTrace = createTraceContext(parseTraceparent(claimed.createdByTraceparent));
  const claim = indexingJobClaim(claimed);
  return runWithTraceContext(workerTrace, () => runWithLogContext({
    ...currentLogContext(),
    requestId: claimed.createdByRequestId,
    traceId: workerTrace.traceId,
    spanId: workerTrace.spanId,
    jobId: claimed.jobId,
    repositoryId: claimed.repositoryId,
    workerId,
  }, async () => {
  logger.info("indexing_job_claimed", jobLogFields(claimed, workerId));
  const jobStartedAtMs = performance.now();
  await observer?.onClaimed?.(claimed);

  const stagesCompleted: IndexingJobStage[] = [];
  let currentStage: IndexingJobStage | null = "pending";
  let repositoryAuthorized = false;

  try {
    await authorizeIndexingJob(claimed, repositoryAuthorizationStore);
    repositoryAuthorized = true;
    const firstStage = "clone";
    currentStage = firstStage;
    const running = await jobStore.markRunning(claimed.jobId, firstStage, claim);
    if (!running) {
      throw new Error("Indexing job could not transition to running");
    }
    if (!jobStore.repositoryStateHandledByJobStore) {
      await repositoryStore.markIndexing(claimed);
    }
    logger.info("indexing_job_started", jobLogFields(claimed, workerId));
    await observer?.onStarted?.(running);
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
        claim,
      );
      if (!updated) {
        throw new Error("Indexing job progress update failed");
      }
      await publishProgressSafely(progressPublisher, updated, logger, workerId);
      await observer?.onProgress?.(updated);
      logger.info("indexing_job_progress", {
        ...jobLogFields(claimed, workerId),
        stage: progress.stage,
        progress: nextProgress,
      });
      stagesCompleted.push(progress.stage);
    };

    const indexingDeadline = createDeadline(quotas.maxIndexingDurationMs, { parentSignal: signal });
    let result: IndexingPipelineResult;
    try {
      result = await waitForDeadline(executeIndexingPipeline({
        job: { ...claimed },
        reportStage,
        retryLogger: logger,
        retryMetrics: metrics?.incrementRetry ? {
          incrementRetry: (category, result, attempt) => metrics.incrementRetry!(category, result, attempt),
        } : undefined,
        circuitBreakers,
        signal: indexingDeadline.signal,
        quotas,
      }), indexingDeadline);
    } catch (error) {
      if (isDeadlineExceeded(error) && indexingDeadline.signal.aborted && !signal?.aborted) {
        throw new RepositoryQuotaError("indexing_duration", quotas.maxIndexingDurationMs, quotas.maxIndexingDurationMs + 1);
      }
      throw error;
    } finally {
      indexingDeadline.dispose();
    }

    currentStage = "finalize";
    if (!jobStore.repositoryStateHandledByJobStore) {
      await repositoryStore.markIndexed(claimed, result);
    }
    const succeeded = await jobStore.markSucceeded(claimed.jobId, claim);
    if (!succeeded) {
      throw new Error("Indexing job could not be marked succeeded");
    }
    const publishedRevision = result.indexOptions?.indexedRevision ??
      (await repositoryAuthorizationStore.getRepository(claimed.repositoryId))?.currentRevision;
    await recordRepositoryLifecycleEvent({
      repositoryId: claimed.repositoryId,
      ownerId: claimed.ownerUserId,
      repositoryRevision: publishedRevision ?? null,
      type: "repository_indexed",
      message: "Repository indexed.",
      metadata: { jobId: claimed.jobId, files: result.counts.fileCount },
      idempotencyKey: `repository-indexed:${claimed.jobId}`,
      requestId: claimed.createdByRequestId,
      traceId: currentTraceContext()?.traceId,
    });
    logger.info("indexing_job_succeeded", {
      ...jobLogFields(claimed, workerId),
      durationMs: Math.max(0, Math.round(performance.now() - jobStartedAtMs)),
    });
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
    if (isIndexingJobLeaseConflict(error)) throw error;
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
    const failed = await jobStore.markFailed(claimed.jobId, failure, claim);
    if (!repositoryAuthorized) {
      logger.error("indexing_job_repository_mismatch", {
        ...jobLogFields(claimed, workerId),
        reasonCode: "worker_job_repository_mismatch",
      });
    } else if (failed && !jobStore.repositoryStateHandledByJobStore) {
      try {
        await repositoryStore.markFailed(claimed, failure);
      } catch {
        // Preserve the original indexing failure in the job/report.
      }
    }
    logger.error("indexing_job_failed", {
      ...jobLogFields(claimed, workerId),
      failureCode: failure.code,
      retryable: failure.retryable,
      durationMs: Math.max(0, Math.round(performance.now() - jobStartedAtMs)),
      ...(failure.details?.reason ? {
        quotaReason: failure.details.reason,
        quotaLimit: failure.details.limit,
        quotaObserved: failure.details.observed,
      } : {}),
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
  }));
}

function isIndexingJobLeaseConflict(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" &&
    (error as { code?: unknown }).code === INDEXING_JOB_LEASE_CONFLICT,
  );
}
