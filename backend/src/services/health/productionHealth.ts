export type ProductionHealthStatus = "healthy" | "degraded" | "unhealthy";
export type ProductionDependencyStatus = "healthy" | "unhealthy";

export interface ProductionHealthContract {
  readonly status: ProductionHealthStatus;
  readonly service: string;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly timestamp: string;
  readonly checks: {
    readonly api: ProductionHealthCheckResult;
    readonly supabase: ProductionHealthCheckResult;
    readonly indexingWorker: ProductionHealthCheckResult;
  };
}

export interface ProductionHealthCheckResult {
  readonly status: ProductionDependencyStatus;
  readonly required: boolean;
}

export interface ProductionHealthDependencies {
  checkSupabase(): void | Promise<void>;
  checkIndexingWorker(): void | Promise<void>;
}

export interface ProductionHealthCheck {
  (): Promise<Pick<ProductionHealthContract, "status" | "checks">>;
}

const HEALTHY_REQUIRED = Object.freeze({ status: "healthy", required: true } as const);
const HEALTHY_OPTIONAL = Object.freeze({ status: "healthy", required: false } as const);
const UNHEALTHY_REQUIRED = Object.freeze({ status: "unhealthy", required: true } as const);
const UNHEALTHY_OPTIONAL = Object.freeze({ status: "unhealthy", required: false } as const);

async function withTimeout(check: () => void | Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(check),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Health dependency check timed out.")), timeoutMs);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createProductionHealthCheck(
  dependencies: ProductionHealthDependencies,
  timeoutMs = 1_000,
): ProductionHealthCheck {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new Error("Production health timeout must be between 1 and 5000 milliseconds.");
  }

  return async () => {
    const [supabaseHealthy, indexingWorkerHealthy] = await Promise.all([
      withTimeout(dependencies.checkSupabase, timeoutMs),
      withTimeout(dependencies.checkIndexingWorker, timeoutMs),
    ]);
    const checks = Object.freeze({
      api: HEALTHY_REQUIRED,
      supabase: supabaseHealthy ? HEALTHY_REQUIRED : UNHEALTHY_REQUIRED,
      indexingWorker: indexingWorkerHealthy ? HEALTHY_OPTIONAL : UNHEALTHY_OPTIONAL,
    });
    const status: ProductionHealthStatus = !supabaseHealthy
      ? "unhealthy"
      : indexingWorkerHealthy ? "healthy" : "degraded";
    return Object.freeze({ status, checks });
  };
}
