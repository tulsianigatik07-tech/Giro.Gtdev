import { criticalPath, independentWork, scheduleWorkUnits } from "./scheduler.js";
import type {
  ExecutionCreationInput,
  ExecutionQuotas,
  ExecutionRun,
} from "./types.js";
import {
  ExecutionOrchestratorError,
  REPOSITORY_EXECUTION_SCHEMA_VERSION,
  REPOSITORY_EXECUTION_VERSION,
} from "./types.js";
import { validateWorkUnits } from "./validation.js";
import { executionIdentity, generateExecutionWorkUnits } from "./workUnitGenerator.js";

export interface PreparedExecution {
  run: ExecutionRun;
  independentWork: string[][];
}

export function prepareExecutionRun(
  input: ExecutionCreationInput,
  quotas: ExecutionQuotas,
  now = new Date().toISOString(),
): PreparedExecution {
  if (input.repositoryDeleted) {
    throw new ExecutionOrchestratorError("repository_deleted", "Deleted repositories cannot be executed.");
  }
  if (input.ownerId !== input.repositoryOwnerId || input.ownerId !== input.planOwnerId) {
    throw new ExecutionOrchestratorError("execution_owner_mismatch", "Execution ownership does not match.");
  }
  if (input.plan.status !== "published") {
    throw new ExecutionOrchestratorError(
      input.plan.status === "superseded" ? "plan_superseded" : "plan_unpublished",
      "A current published plan is required.",
    );
  }
  if (input.plan.repositoryId !== input.repositoryId) {
    throw new ExecutionOrchestratorError("plan_repository_mismatch", "Plan repository does not match.");
  }
  if (input.plan.repositoryRevision !== input.repositoryRevision) {
    throw new ExecutionOrchestratorError("stale_repository_revision", "Plan revision is stale.");
  }
  if (input.policy === "guarded_execution" && !input.guardedExecutionEnabled) {
    throw new ExecutionOrchestratorError(
      "guarded_execution_disabled",
      "Guarded execution is disabled by configuration.",
    );
  }
  const constraints = input.userConstraints ?? {};
  const identity = executionIdentity(input.plan, input.policy, constraints);
  const units = generateExecutionWorkUnits(input.plan, input.policy, quotas.attemptsPerWorkUnit);
  if (units.length > quotas.workUnitsPerRun) {
    throw new ExecutionOrchestratorError("execution_work_unit_quota_exceeded", "Plan produces too many work units.", {
      limit: quotas.workUnitsPerRun,
      requested: units.length,
    });
  }
  validateWorkUnits(units);
  const states = scheduleWorkUnits(units.map((unit) => ({
    ...unit,
    status: "blocked" as const,
    attempt: 0,
    outputVersion: 0,
    createdAt: now,
    updatedAt: now,
  })));
  const reviewOnly = input.policy === "review_only";
  return {
    independentWork: independentWork(units),
    run: {
      ...identity,
      schemaVersion: REPOSITORY_EXECUTION_SCHEMA_VERSION,
      orchestratorVersion: REPOSITORY_EXECUTION_VERSION,
      ownerId: input.ownerId,
      repositoryId: input.repositoryId,
      repositoryRevision: input.repositoryRevision,
      sourcePlanId: input.plan.taskHash,
      sourcePlanVersion: input.plan.planVersion,
      policy: input.policy,
      userConstraints: structuredClone(constraints),
      status: reviewOnly ? "paused" : "awaiting_approval",
      workUnits: states,
      criticalPath: criticalPath(units),
      approvalState: reviewOnly ? "not_required" : "pending",
      approvals: [],
      leases: [],
      outputs: [],
      reviews: [],
      diagnostics: [],
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      startedAt: null,
      completedAt: null,
    },
  };
}
