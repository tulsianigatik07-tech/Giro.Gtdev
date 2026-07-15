import { logger } from "../../../lib/logger.js";
import { runtimeMetrics } from "../../../observability/metrics.js";
import { runtimeIndexingJobStore } from "../jobs/runtimeIndexingJobStore.js";
import { IndexingProgressPublisher } from "./indexingProgressPublisher.js";

export const runtimeIndexingProgressPublisher = new IndexingProgressPublisher({
  jobStore: runtimeIndexingJobStore,
  metrics: runtimeMetrics,
  logger,
});
