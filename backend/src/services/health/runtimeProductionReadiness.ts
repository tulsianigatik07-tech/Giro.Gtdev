import { constants } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "../../config/env.js";
import {
  checkRepositoryStorageAccess,
  repositoryStorageRoot,
} from "../../config/repositoryStorage.js";
import { supabase } from "../../lib/supabase.js";
import {
  createProductionReadinessCheck,
  type ProductionReadinessCheck,
} from "./productionReadiness.js";
import {
  checkIndexingWorkerReadiness,
  checkSupabaseConnectivity,
} from "./runtimeProductionHealth.js";

export function createRuntimeProductionReadinessCheck(options: {
  client?: SupabaseClient;
  timeoutMs?: number;
  isStartupComplete?: () => boolean;
  isShuttingDown?: () => boolean;
  workerEnabled?: boolean;
} = {}): ProductionReadinessCheck {
  const client = options.client ?? supabase;
  return createProductionReadinessCheck({
    isStartupComplete: options.isStartupComplete ?? (() => true),
    checkSupabase: () => checkSupabaseConnectivity(client),
    checkEnvironment: () => {
      if (!Object.isFrozen(env)) throw new Error("Environment is not validated.");
    },
    checkStorage: () => checkRepositoryStorageAccess(
      repositoryStorageRoot,
      constants.F_OK | constants.W_OK,
    ),
    isShuttingDown: options.isShuttingDown ?? (() => false),
    workerEnabled: options.workerEnabled ?? env.INDEXING_WORKER_ENABLED,
    checkIndexingWorker: () => checkIndexingWorkerReadiness(client),
  }, options.timeoutMs);
}
