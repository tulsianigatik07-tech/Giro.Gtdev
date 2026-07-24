import { env } from "../../config/env.js";
import { runtimeMetrics } from "../../observability/metrics.js";
import { prepareExecutionRun } from "./orchestrator.js";
import type {
  ExecutionCreationInput,
  ExecutionQuotas,
} from "./types.js";
import type {
  ExecutionApprovalInput,
  ExecutionClaimInput,
  ExecutionLeaseInput,
  RepositoryExecutionStore,
} from "./store.js";
import { runtimeRepositoryExecutionStore } from "./store.js";
import type { AgentWorkUnitOutput, ReviewVerdict, WorkUnitReview } from "./types.js";

export const runtimeExecutionQuotas: ExecutionQuotas = Object.freeze({
  activeRunsPerUser: env.EXECUTION_MAX_ACTIVE_RUNS_PER_USER,
  workUnitsPerRun: env.EXECUTION_MAX_WORK_UNITS_PER_RUN,
  concurrentLeasesPerUser: env.EXECUTION_MAX_CONCURRENT_LEASES_PER_USER,
  attemptsPerWorkUnit: env.EXECUTION_MAX_ATTEMPTS_PER_WORK_UNIT,
  outputBytes: env.EXECUTION_MAX_OUTPUT_BYTES,
  executionDurationMs: env.EXECUTION_MAX_DURATION_MS,
  retainedRuns: env.EXECUTION_RETAINED_RUNS,
});

export class RepositoryExecutionOrchestrator {
  constructor(
    private readonly store: RepositoryExecutionStore = runtimeRepositoryExecutionStore,
    private readonly quotas: ExecutionQuotas = runtimeExecutionQuotas,
  ) {}

  async create(input: ExecutionCreationInput) {
    const prepared = prepareExecutionRun({
      ...input,
      guardedExecutionEnabled: input.guardedExecutionEnabled ?? env.GUARDED_EXECUTION_ENABLED,
    }, this.quotas);
    const run = await this.store.create(prepared.run, input.idempotencyKey, this.quotas);
    runtimeMetrics.recordRepositoryExecution({
      created: 1,
      activeRuns: 1,
      readyUnits: run.workUnits.filter((unit) => unit.status === "ready").length,
      blockedUnits: run.workUnits.filter((unit) => unit.status === "blocked").length,
    });
    return run;
  }

  get(ownerId: string, repositoryId: string, executionId: string) {
    return this.store.get(ownerId, repositoryId, executionId);
  }

  list(ownerId: string, repositoryId: string, cursor?: string, limit?: number) {
    return this.store.list(ownerId, repositoryId, cursor, limit);
  }

  async approve(input: ExecutionApprovalInput) {
    const run = await this.store.approve(input);
    runtimeMetrics.recordRepositoryExecution({ approvals: 1 });
    return run;
  }

  reject(input: ExecutionApprovalInput) {
    return this.store.reject(input);
  }

  async leaseNext(input: Omit<ExecutionLeaseInput, "leaseMs"> & { leaseMs?: number }) {
    const lease = await this.store.leaseNext({
      ...input,
      leaseMs: input.leaseMs ?? env.EXECUTION_LEASE_MS,
    }, this.quotas);
    if (lease) runtimeMetrics.recordRepositoryExecution({ runningUnits: 1 });
    return lease;
  }

  heartbeat(input: ExecutionClaimInput, leaseMs = env.EXECUTION_LEASE_MS) {
    return this.store.heartbeat(input, leaseMs);
  }

  publishOutput(input: ExecutionClaimInput, output: AgentWorkUnitOutput, idempotencyKey: string) {
    return this.store.publishOutput(input, output, idempotencyKey, this.quotas);
  }

  submitReview(input: {
    ownerId: string; repositoryId: string; executionId: string; workUnitId: string;
    reviewerId: string; reviewerType: WorkUnitReview["reviewerType"]; verdict: ReviewVerdict;
    findings: string[]; requiredCorrections: string[]; reviewedOutputVersion: number; idempotencyKey: string;
  }) {
    return this.store.submitReview(input);
  }

  failUnit(input: ExecutionClaimInput, code: string, message: string, retryable: boolean) {
    runtimeMetrics.recordRepositoryExecution({ failures: retryable ? 0 : 1, retries: retryable ? 1 : 0 });
    return this.store.failUnit(input, code, message, retryable);
  }

  cancel(ownerId: string, repositoryId: string, executionId: string, idempotencyKey: string) {
    return this.store.cancel(ownerId, repositoryId, executionId, idempotencyKey);
  }
}

export const runtimeRepositoryExecutionOrchestrator = new RepositoryExecutionOrchestrator();
