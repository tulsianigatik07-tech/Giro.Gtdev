// Process entrypoint. Boots the HTTP server using @hono/node-server.

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { env } from "./config/env.js";
import { flushLogs, logger } from "./lib/logger.js";
import { closeSupabaseConnections } from "./lib/supabase.js";
import { createApp } from "./app.js";
import {
  createBackendShutdown,
  installShutdownSignalHandlers,
} from "./runtime/backendShutdown.js";
import {
  forceCloseHttpServer,
  stopHttpServer,
} from "./runtime/httpServerShutdown.js";
import { stopRegisteredIndexingWorkers } from "./runtime/indexingWorkerShutdown.js";
import { runtimeIndexingJobStore } from "./services/indexing/jobs/runtimeIndexingJobStore.js";
import { recoverIndexingJobsOnStartup } from "./services/indexing/jobs/indexingJobStartupRecovery.js";
import { runtimeRepositoryDeletionService } from "./services/repository/repositoryDeletionService.js";
import { rateLimitBackend, runtimeRateLimitStore } from "./services/rateLimit/runtimeRateLimitStore.js";
import { recoverAbandonedRepositoryCheckouts } from "./services/repository/revisionCheckouts.js";
import { repositoryStore } from "./services/repository/store/runtimeRepositoryStore.js";
import { runtimeRepositoryConnectionStore } from "./services/repository/connection/runtimeRepositoryConnectionStore.js";
import { sessionStore } from "./services/sessions/store.js";
import { repositoryHistoryStore } from "./services/repository/history/runtimeRepositoryHistoryStore.js";
import { runtimeEmbeddingIndexStore } from "./services/embeddings/indexStore.js";
import {
  runtimeHybridRetrievalV2Config,
  validateHybridRetrievalV2Config,
} from "./services/retrieval/hybridV2/config.js";
import { runtimeCrossEncoder } from "./services/retrieval/hybridV2/crossEncoder.js";
import { runtimeRepositoryGraphStore } from "./services/repositoryGraph/graphStore.js";
import { runtimeRepositoryIntelligenceStore } from "./services/repositoryIntelligence/store.js";
import { runtimeRepositoryPlanningStore } from "./services/repositoryPlanning/store.js";
import { runtimeRepositoryExecutionStore } from "./services/repositoryExecution/store.js";

let server: ServerType;
let startupCompleted = false;
const coordinator = createBackendShutdown({
  logger,
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  stopAcceptingRequests: () => stopHttpServer(server),
  stopIndexingWorkers: stopRegisteredIndexingWorkers,
  closeDatabase: closeSupabaseConnections,
  flushLogs,
  forceStop: () => forceCloseHttpServer(server),
});
const app = createApp({
  isShuttingDown: coordinator.isShuttingDown,
  isStartupComplete: () => startupCompleted,
});

try {
  await runtimeRateLimitStore.verify();
  logger.info("rate_limit_backend_verified", { backend: rateLimitBackend });
} catch {
  logger.error("rate_limit_backend_verification_failed", {
    source: "backend_startup",
    backend: rateLimitBackend,
    reasonCode: "rate_limit_backend_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await runtimeRepositoryConnectionStore.verify();
  const removed = await runtimeRepositoryConnectionStore.cleanupExpired();
  logger.info("repository_connection_idempotency_verified", {
    source: "backend_startup",
    expiredRecordsRemoved: removed,
  });
} catch {
  logger.error("repository_connection_idempotency_verification_failed", {
    source: "backend_startup",
    reasonCode: "idempotency_database_objects_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await sessionStore.verifyTurnPersistence();
  const removed = await sessionStore.cleanupExpiredTurnIdempotency();
  logger.info("session_persistence_contract_verified", {
    source: "backend_startup",
    expiredTurnRecordsRemoved: removed,
  });
} catch {
  logger.error("session_persistence_contract_verification_failed", {
    source: "backend_startup",
    reasonCode: "session_database_objects_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await repositoryHistoryStore.verifyPersistence();
  const removed = await repositoryHistoryStore.cleanup({
    maxRecordsPerType: env.REPOSITORY_HISTORY_MAX_RECORDS_PER_TYPE,
    maxAgeMs: env.REPOSITORY_HISTORY_MAX_AGE_MS,
  });
  logger.info("repository_history_contract_verified", {
    source: "backend_startup",
    expiredOrExcessRecordsRemoved: removed,
  });
} catch {
  logger.error("repository_history_contract_verification_failed", {
    source: "backend_startup",
    reasonCode: "repository_history_database_objects_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await recoverIndexingJobsOnStartup({
    jobStore: runtimeIndexingJobStore,
    logger,
    leaseDurationMs: env.INDEXING_WORKER_STALE_CLAIM_MS,
    retryDelayMs: env.INDEXING_WORKER_RETRY_BASE_MS,
  });
} catch {
  logger.error("indexing_recovery_failed", {
    source: "backend_startup",
    reasonCode: "durable_recovery_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await runtimeEmbeddingIndexStore.verify();
  const cleanedVersionCount = await runtimeEmbeddingIndexStore.recover();
  logger.info("embedding_index_contract_verified", {
    source: "backend_startup",
    cleanedVersionCount,
  });
} catch {
  logger.error("embedding_index_contract_verification_failed", {
    source: "backend_startup",
    reasonCode: "embedding_index_database_objects_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await runtimeRepositoryGraphStore.verify();
  const cleanedVersionCount = await runtimeRepositoryGraphStore.recover();
  logger.info("repository_graph_contract_verified", {
    source: "backend_startup",
    parserVersion: "typescript-compiler-v1",
    cleanedVersionCount,
  });
} catch {
  logger.error("repository_graph_contract_verification_failed", {
    source: "backend_startup",
    reasonCode: "repository_graph_database_objects_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await runtimeRepositoryIntelligenceStore.verify();
  const cleanedVersionCount = await runtimeRepositoryIntelligenceStore.recover();
  logger.info("repository_intelligence_contract_verified", {
    source: "backend_startup",
    analysisVersion: "repository-intelligence-v1",
    cleanedVersionCount,
  });
} catch {
  logger.error("repository_intelligence_contract_verification_failed", {
    source: "backend_startup",
    reasonCode: "repository_intelligence_database_objects_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await runtimeRepositoryPlanningStore.verify();
  const recoveredPlanCount = await runtimeRepositoryPlanningStore.recover();
  logger.info("repository_planning_contract_verified", {
    source: "backend_startup",
    plannerVersion: "repository-planner-v1",
    recoveredPlanCount,
  });
} catch {
  logger.error("repository_planning_contract_verification_failed", {
    source: "backend_startup",
    reasonCode: "repository_planning_database_objects_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await runtimeRepositoryExecutionStore.verify();
  const recoveredLeaseCount = await runtimeRepositoryExecutionStore.recover();
  logger.info("repository_execution_contract_verified", {
    source: "backend_startup",
    orchestratorVersion: "repository-execution-v1",
    guardedExecutionEnabled: env.GUARDED_EXECUTION_ENABLED,
    recoveredLeaseCount,
  });
} catch {
  logger.error("repository_execution_contract_verification_failed", {
    source: "backend_startup",
    reasonCode: "repository_execution_database_objects_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  validateHybridRetrievalV2Config(runtimeHybridRetrievalV2Config);
  await runtimeCrossEncoder.verify();
  logger.info("hybrid_retrieval_v2_contract_verified", {
    source: "backend_startup",
    rerankerProvider: runtimeCrossEncoder.name,
    maximumTokenBudget: runtimeHybridRetrievalV2Config.maxTokens,
  });
} catch {
  logger.error("hybrid_retrieval_v2_contract_verification_failed", {
    source: "backend_startup",
    reasonCode: "retrieval_configuration_or_reranker_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  await runtimeRepositoryDeletionService.recoverPendingFilesystemCleanup();
} catch {
  logger.error("repository_deletion_recovery_failed", {
    source: "backend_startup",
    reasonCode: "durable_cleanup_recovery_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

try {
  for (const repository of await repositoryStore.listRepositories()) {
    await recoverAbandonedRepositoryCheckouts(
      repository.repositoryId,
      repositoryStore,
      runtimeIndexingJobStore,
    );
  }
} catch {
  logger.error("repository_quota_cleanup_recovery_failed", {
    source: "backend_startup",
    reasonCode: "abandoned_checkout_cleanup_unavailable",
  });
  await flushLogs();
  process.exit(1);
}

server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    startupCompleted = true;
    logger.info("server_started", {
      port: info.port,
      env: env.NODE_ENV,
    });
  },
);

installShutdownSignalHandlers({
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
});
