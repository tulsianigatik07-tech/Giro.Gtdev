import { env } from "../../../config/env.js";
import { logger } from "../../../lib/logger.js";
import { runtimeMetrics } from "../../../observability/metrics.js";
import { repositoryStore } from "../../repository/store/runtimeRepositoryStore.js";
import { RetrievalCache } from "./retrievalCache.js";

export const runtimeRetrievalCache = new RetrievalCache({
  ttlMs: env.RETRIEVAL_CACHE_TTL_MS,
  maxEntries: env.RETRIEVAL_CACHE_MAX_ENTRIES,
  metrics: runtimeMetrics,
  logger,
  versionProvider: async (repositoryId) => {
    const repository = await repositoryStore.getRepository(repositoryId);
    if (!repository?.indexedRevision) {
      throw new Error("Repository has no published revision.");
    }
    return repository.indexedRevision;
  },
});
