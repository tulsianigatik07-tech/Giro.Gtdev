import { buildRepositoryConnectFailureError } from "../../repository/cloneFailureClassifier.js";
import { cloneRepo } from "../../repository/clone.js";
import { scanRepo } from "../../repository/scanner.js";
import { analyzeRepository } from "../../repository/analyzer.js";
import { extractRepoSymbols } from "../../graph/symbolExtractor.js";
import { applyGraphUpdate } from "../../repository/graphUpdateExecutor.js";
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

export interface IndexingPipelineStageProgress {
  stage: IndexingJobStage;
  progress: number;
}

export interface IndexingPipelineInput {
  job: IndexingJob;
  reportStage: (progress: IndexingPipelineStageProgress) => Promise<void>;
}

export interface IndexingPipelineResult {
  counts: IndexedCounts;
  indexOptions?: SetRepositoryIndexedOptions;
}

export type ExecuteIndexingPipeline = (
  input: IndexingPipelineInput,
) => Promise<IndexingPipelineResult>;

export interface IndexingJobRepositoryStore {
  markIndexing(job: IndexingJob): void;
  markIndexed(job: IndexingJob, result: IndexingPipelineResult): void;
  markFailed(job: IndexingJob, failure: IndexingJobFailure): void;
}

export interface ProcessNextIndexingJobInput {
  workerId: string;
  jobStore: IndexingJobStore;
  repositoryStore?: IndexingJobRepositoryStore;
  executeIndexingPipeline?: ExecuteIndexingPipeline;
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

const defaultRepositoryStore: IndexingJobRepositoryStore = {
  markIndexing(job) {
    setRepositoryIndexing(job.repositoryOwner, job.repositoryName);
  },
  markIndexed(job, result) {
    setRepositoryIndexed(
      job.repositoryOwner,
      job.repositoryName,
      result.counts,
      result.indexOptions,
    );
  },
  markFailed(job) {
    setRepositoryFailed(job.repositoryOwner, job.repositoryName);
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
  const { clonePath } = await cloneRepo(owner, repo);

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
  const context = await buildRepositoryContext(clonePath, repoId);

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
    },
  };
}

export async function processNextIndexingJob(
  input: ProcessNextIndexingJobInput,
): Promise<IndexingJobExecutionReport> {
  const {
    workerId,
    jobStore,
    repositoryStore = defaultRepositoryStore,
    executeIndexingPipeline = executeRepositoryIndexingPipeline,
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

  const stagesCompleted: IndexingJobStage[] = [];
  let currentStage: IndexingJobStage | null = "pending";

  try {
    repositoryStore.markIndexing(claimed);
    const firstStage = "clone";
    currentStage = firstStage;
    const running = await jobStore.markRunning(claimed.jobId, firstStage);
    if (!running) {
      throw new Error("Indexing job could not transition to running");
    }

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
      stagesCompleted.push(progress.stage);
    };

    const result = await executeIndexingPipeline({
      job: { ...claimed },
      reportStage,
    });

    currentStage = "finalize";
    repositoryStore.markIndexed(claimed, result);
    const succeeded = await jobStore.markSucceeded(claimed.jobId);
    if (!succeeded) {
      throw new Error("Indexing job could not be marked succeeded");
    }

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
    const failure = normalizeIndexingJobFailure(error, {
      repositoryId: claimed.repositoryId,
      stage: currentStage,
    });
    try {
      repositoryStore.markFailed(claimed, failure);
    } catch {
      // Preserve the original indexing failure in the job/report.
    }
    await jobStore.markFailed(claimed.jobId, failure);
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
