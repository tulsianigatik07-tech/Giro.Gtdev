import { runBoundedDependencyCheck } from "./boundedDependencyCheck.js";

export type ProductionReadinessStatus = "ready" | "not_ready";
export type ProductionReadinessDependencyStatus = "pass" | "fail" | "skip";

export interface ProductionReadinessCheckResult {
  readonly status: ProductionReadinessDependencyStatus;
  readonly required: boolean;
}

export interface ProductionReadinessChecks {
  readonly startup: ProductionReadinessCheckResult;
  readonly supabase: ProductionReadinessCheckResult;
  readonly environment: ProductionReadinessCheckResult;
  readonly storage: ProductionReadinessCheckResult;
  readonly shutdown: ProductionReadinessCheckResult;
  readonly indexingWorker: ProductionReadinessCheckResult;
}

export interface ProductionReadinessContract {
  readonly status: ProductionReadinessStatus;
  readonly service: string;
  readonly version: string;
  readonly timestamp: string;
  readonly checks: ProductionReadinessChecks;
}

export interface ProductionReadinessDependencies {
  isStartupComplete(): boolean;
  checkSupabase(): void | Promise<void>;
  checkEnvironment(): void | Promise<void>;
  checkStorage(): void | Promise<void>;
  isShuttingDown(): boolean;
  readonly workerEnabled: boolean;
  checkIndexingWorker(): void | Promise<void>;
}

export interface ProductionReadinessCheck {
  (): Promise<Pick<ProductionReadinessContract, "status" | "checks">>;
}

const PASS = Object.freeze({ status: "pass", required: true } as const);
const FAIL = Object.freeze({ status: "fail", required: true } as const);
const SKIP = Object.freeze({ status: "skip", required: false } as const);

export function createProductionReadinessCheck(
  dependencies: ProductionReadinessDependencies,
  timeoutMs = 1_000,
): ProductionReadinessCheck {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new Error("Production readiness timeout must be between 1 and 5000 milliseconds.");
  }

  return async () => {
    const workerCheck = dependencies.workerEnabled
      ? runBoundedDependencyCheck(dependencies.checkIndexingWorker, timeoutMs)
      : Promise.resolve(undefined);
    const [supabaseReady, environmentReady, storageReady, workerReady] =
      await Promise.all([
        runBoundedDependencyCheck(dependencies.checkSupabase, timeoutMs),
        runBoundedDependencyCheck(dependencies.checkEnvironment, timeoutMs),
        runBoundedDependencyCheck(dependencies.checkStorage, timeoutMs),
        workerCheck,
      ]);
    const startupReady = dependencies.isStartupComplete();
    const shutdownReady = !dependencies.isShuttingDown();
    const checks: ProductionReadinessChecks = Object.freeze({
      startup: startupReady ? PASS : FAIL,
      supabase: supabaseReady ? PASS : FAIL,
      environment: environmentReady ? PASS : FAIL,
      storage: storageReady ? PASS : FAIL,
      shutdown: shutdownReady ? PASS : FAIL,
      indexingWorker: dependencies.workerEnabled
        ? workerReady ? PASS : FAIL
        : SKIP,
    });
    const status: ProductionReadinessStatus = Object.values(checks).some(
      (check) => check.required && check.status === "fail",
    ) ? "not_ready" : "ready";
    return Object.freeze({ status, checks });
  };
}
