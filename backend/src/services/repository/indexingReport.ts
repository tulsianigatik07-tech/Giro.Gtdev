import type { RepositoryIndexMetadata } from "./indexingTypes.js";
import {
  buildRepositoryIndexingMetrics,
} from "./indexingMetrics.js";
import {
  buildRepositoryIndexingHealth,
} from "./indexingHealth.js";

export interface RepositoryIndexingReport {
  metrics: ReturnType<typeof buildRepositoryIndexingMetrics>;
  health: ReturnType<typeof buildRepositoryIndexingHealth>;
}

export function buildRepositoryIndexingReport(
  metadata: RepositoryIndexMetadata | null,
): RepositoryIndexingReport {
  const metrics = buildRepositoryIndexingMetrics(metadata);
  const health = buildRepositoryIndexingHealth(metrics);

  return {
    metrics,
    health,
  };
}