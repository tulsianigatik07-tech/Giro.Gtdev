import { performance } from "node:perf_hooks";
import { logger as runtimeLogger } from "../../lib/logger.js";
import { runtimeMetrics } from "../../observability/metrics.js";
import { buildRepositoryArchitectureSummary } from "./summaryBuilder.js";
import { saveRepositorySummary } from "./runtimeRepositorySummary.js";
import type {
  RepositorySummary,
  RepositorySummaryBuildInput,
  RepositorySummaryLogger,
  RepositorySummaryMetrics,
} from "./summaryTypes.js";

export function generateRepositorySummary(
  input: RepositorySummaryBuildInput,
  options: {
    metrics?: RepositorySummaryMetrics;
    logger?: RepositorySummaryLogger;
    now?: () => number;
  } = {},
): RepositorySummary {
  const metrics = options.metrics ?? runtimeMetrics;
  const summaryLogger = options.logger ?? runtimeLogger;
  const now = options.now ?? (() => performance.now());
  const started = now();
  const summary = buildRepositoryArchitectureSummary(input);
  const durationMs = Math.max(0, Math.round(now() - started));

  saveRepositorySummary(summary);
  metrics.incrementRepositorySummary();
  metrics.observeRepositorySummaryGenerationMs(durationMs);
  summaryLogger.info("repository_summary_generated", {
    repositoryId: summary.repositoryId,
    repositoryVersion: summary.repositoryVersion,
    languageCount: summary.languages.length,
    frameworkCount: summary.frameworks.length,
    moduleCount: summary.modules.length,
    durationMs,
  });
  return summary;
}
