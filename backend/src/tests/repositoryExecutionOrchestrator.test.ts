import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { MetricsRegistry } from "../observability/metrics.js";
import { prepareExecutionRun } from "../services/repositoryExecution/orchestrator.js";
import { independentWork } from "../services/repositoryExecution/scheduler.js";
import {
  MemoryRepositoryExecutionStore,
  SupabaseRepositoryExecutionStore,
} from "../services/repositoryExecution/store.js";
import type {
  AgentWorkUnitOutput,
  ExecutionCreationInput,
  ExecutionQuotas,
  ExecutionRun,
} from "../services/repositoryExecution/types.js";
import { ExecutionOrchestratorError } from "../services/repositoryExecution/types.js";
import { generateExecutionWorkUnits } from "../services/repositoryExecution/workUnitGenerator.js";
import type { RepositoryPlanRecord } from "../services/repositoryPlanning/types.js";

const quotas: ExecutionQuotas = {
  activeRunsPerUser: 10,
  workUnitsPerRun: 20,
  concurrentLeasesPerUser: 4,
  attemptsPerWorkUnit: 3,
  outputBytes: 100_000,
  executionDurationMs: 86_400_000,
  retainedRuns: 2,
};

function plan(overrides: Partial<RepositoryPlanRecord> = {}): RepositoryPlanRecord {
  return {
    planVersion: "plan-v1",
    taskHash: "a".repeat(64),
    repositoryId: "acme/widgets",
    repositoryRevision: "rev-1",
    intelligenceVersion: "intel-1",
    graphVersion: "graph-1",
    embeddingVersion: "embedding-1",
    plannerVersion: "repository-planner-v1",
    schemaVersion: "repository-plan-schema-v1",
    objective: "Add guarded widget creation",
    assumptions: [],
    affectedSubsystems: ["database", "service", "api", "docs"],
    affectedFiles: [
      { path: "src/db.ts", reasons: ["task"], retrievalScore: null },
      { path: "src/service.ts", reasons: ["task"], retrievalScore: null },
      { path: "src/api.ts", reasons: ["task"], retrievalScore: null },
      { path: "docs/widgets.md", reasons: ["task"], retrievalScore: null },
    ],
    affectedSymbols: [
      { nodeId: "db", qualifiedName: "db.save", file: "src/db.ts", kind: "function", publicApi: false },
      { nodeId: "service", qualifiedName: "service.create", file: "src/service.ts", kind: "function", publicApi: true },
      { nodeId: "api", qualifiedName: "api.post", file: "src/api.ts", kind: "function", publicApi: true },
    ],
    dependencyOrder: {
      dependencies: [],
      orderedFiles: ["src/db.ts", "src/service.ts", "src/api.ts", "docs/widgets.md"],
      independentWork: [],
      blockingDependencies: [],
      circularPlans: [],
    },
    implementationPhases: [
      {
        phaseId: "database", order: 0, name: "Database", kind: "implementation",
        subsystemIds: ["database"], files: ["src/db.ts"], symbols: ["db"],
        dependsOn: [], operations: ["modify"], independentlyExecutable: true,
      },
      {
        phaseId: "service", order: 1, name: "Service", kind: "implementation",
        subsystemIds: ["service"], files: ["src/service.ts"], symbols: ["service"],
        dependsOn: ["database"], operations: ["modify"], independentlyExecutable: false,
      },
      {
        phaseId: "api", order: 2, name: "API", kind: "integration",
        subsystemIds: ["api"], files: ["src/api.ts"], symbols: ["api"],
        dependsOn: ["service"], operations: ["modify"], independentlyExecutable: false,
      },
      {
        phaseId: "docs", order: 3, name: "Documentation", kind: "validation",
        subsystemIds: ["docs"], files: ["docs/widgets.md"], symbols: [],
        dependsOn: [], operations: ["modify"], independentlyExecutable: true,
      },
    ],
    validationSteps: [
      { validationId: "typecheck", kind: "static", command: "pnpm typecheck", required: true },
      { validationId: "test", kind: "test", command: "pnpm test", required: true },
    ],
    testingStrategy: { unit: ["service"], integration: ["api"], regression: ["all"] },
    migrationRequirements: { required: false, reasons: [], affectedFiles: [], reversible: true },
    rollbackStrategy: { phaseOrder: ["api", "service", "database"], preserveData: true, actions: ["Revert proposals"] },
    riskAnalysis: {
      architecturalRisk: 0.4, dependencyRisk: 0.5, blastRadius: 0.4,
      publicApiImpact: 0.6, migrationImpact: 0, testingComplexity: 0.5,
      overallRisk: 0.45, level: "medium",
    },
    confidenceScore: 0.9,
    retrievalContribution: { used: false, candidateCount: 0, affectedFileCount: 0, maximumScore: 0 },
    inputStatistics: { repositoryFiles: 4, repositorySymbols: 3, dependencyEdges: 2, historyRecords: 1 },
    status: "published",
    createdAt: "2026-07-24T00:00:00.000Z",
    validatedAt: "2026-07-24T00:00:01.000Z",
    publishedAt: "2026-07-24T00:00:02.000Z",
    publicationMetadata: {
      previousPlanVersion: null, repositoryRevision: "rev-1", intelligenceVersion: "intel-1",
      graphVersion: "graph-1", embeddingVersion: "embedding-1",
    },
    ...overrides,
  };
}

function creation(overrides: Partial<ExecutionCreationInput> = {}): ExecutionCreationInput {
  return {
    ownerId: "user-1",
    planOwnerId: "user-1",
    repositoryOwnerId: "user-1",
    repositoryId: "acme/widgets",
    repositoryRevision: "rev-1",
    plan: plan(),
    policy: "agent_assisted",
    idempotencyKey: "create-1",
    ...overrides,
  };
}

function prepared(overrides: Partial<ExecutionCreationInput> = {}, quotaOverrides: Partial<ExecutionQuotas> = {}) {
  return prepareExecutionRun(creation(overrides), { ...quotas, ...quotaOverrides }).run;
}

const output: AgentWorkUnitOutput = {
  summary: "Proposed a bounded implementation.",
  filesConsidered: ["src/db.ts"],
  proposedChanges: [{ file: "src/db.ts", operation: "modify", description: "Add guarded write." }],
  commandsProposed: ["pnpm test"],
  testsProposed: ["widget persistence"],
  risksDiscovered: [],
  blockers: [],
  artifacts: [{ kind: "proposal", uri: "artifact://proposal/1", digest: "abc" }],
  completionStatus: "completed",
};

async function createApproved(store: MemoryRepositoryExecutionStore, run = prepared()) {
  await store.create(run, "create", quotas);
  await store.approve({
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    executionVersion: run.executionVersion, repositoryRevision: run.repositoryRevision,
    idempotencyKey: "approve", 
  });
  return run;
}

function claim(run: ExecutionRun, lease: { workUnitId: string; workerId: string; claimToken: string }) {
  return {
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    workUnitId: lease.workUnitId, workerId: lease.workerId, claimToken: lease.claimToken,
  };
}

test("work-unit generation is deterministic, ordered, safe, and policy-derived", () => {
  const first = generateExecutionWorkUnits(plan(), "agent_assisted", 3);
  const second = generateExecutionWorkUnits(plan(), "agent_assisted", 3);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((unit) => unit.phaseId), ["database", "service", "api", "docs"]);
  assert.ok(first.every((unit) => unit.forbiddenOperations.includes("execute_arbitrary_shell_commands")));
  assert.ok(first.every((unit) => unit.allowedOperations.includes("propose_changes")));
});

test("dependency ordering, independent work, parallel safety, and critical path are derived", () => {
  const result = prepareExecutionRun(creation(), quotas);
  assert.deepEqual(result.independentWork[0]?.map((id) =>
    result.run.workUnits.find((unit) => unit.workUnitId === id)?.phaseId).sort(), ["database", "docs"]);
  assert.deepEqual(result.run.criticalPath.map((id) =>
    result.run.workUnits.find((unit) => unit.workUnitId === id)?.phaseId), ["database", "service", "api"]);
  assert.equal(result.run.workUnits.find((unit) => unit.phaseId === "docs")?.parallelSafe, true);
  assert.doesNotThrow(() => independentWork(result.run.workUnits));
});

test("unpublished, superseded, stale, cross-owner, and deleted inputs are rejected", () => {
  const cases: Array<[string, Partial<ExecutionCreationInput>]> = [
    ["plan_unpublished", { plan: plan({ status: "building" }) }],
    ["plan_superseded", { plan: plan({ status: "superseded" }) }],
    ["stale_repository_revision", { repositoryRevision: "rev-2" }],
    ["execution_owner_mismatch", { planOwnerId: "user-2" }],
    ["repository_deleted", { repositoryDeleted: true }],
  ];
  for (const [code, input] of cases) {
    assert.throws(() => prepareExecutionRun(creation(input), quotas),
      (error: unknown) => error instanceof ExecutionOrchestratorError && error.code === code);
  }
});

test("guarded execution is disabled by default and review-only cannot lease", async () => {
  assert.throws(() => prepareExecutionRun(creation({ policy: "guarded_execution" }), quotas),
    /Guarded execution is disabled/);
  const store = new MemoryRepositoryExecutionStore();
  const run = prepared({ policy: "review_only", idempotencyKey: "review" });
  await store.create(run, "review", quotas);
  assert.equal(run.status, "paused");
  await assert.rejects(() => store.leaseNext({
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    workerId: "agent-1", leaseMs: 60_000,
  }, quotas), /requires approval/);
});

test("creation and approval are durable, idempotent, traceable, and revision fenced", async () => {
  const store = new MemoryRepositoryExecutionStore();
  const run = prepared();
  const first = await store.create(run, "same-create", quotas);
  assert.deepEqual(await store.create(run, "same-create", quotas), first);
  const request = {
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    executionVersion: run.executionVersion, repositoryRevision: run.repositoryRevision,
    idempotencyKey: "approve-1",
  };
  const approved = await store.approve(request);
  assert.deepEqual(await store.approve(request), approved);
  assert.equal(approved.approvals.length, 1);
  await assert.rejects(() => store.approve({ ...request, idempotencyKey: "stale", repositoryRevision: "rev-2" }),
    /stale version/);
});

test("selected work-unit approval permits only explicitly approved ready work", async () => {
  const store = new MemoryRepositoryExecutionStore();
  const run = prepared();
  await store.create(run, "selected", quotas);
  const database = run.workUnits.find((unit) => unit.phaseId === "database")!;
  await store.approve({
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    executionVersion: run.executionVersion, repositoryRevision: run.repositoryRevision,
    workUnitIds: [database.workUnitId], idempotencyKey: "selected-approval",
  });
  const lease = await store.leaseNext({
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    workerId: "agent-1", leaseMs: 60_000,
  }, quotas);
  assert.equal(lease?.workUnitId, database.workUnitId);
});

test("concurrent claims are exclusive and heartbeat extends the fenced lease", async () => {
  const store = new MemoryRepositoryExecutionStore();
  const run = await createApproved(store);
  const leases = await Promise.all([
    store.leaseNext({ ownerId: run.ownerId, repositoryId: run.repositoryId,
      executionId: run.executionId, workerId: "agent-a", leaseMs: 30_000 }, quotas),
    store.leaseNext({ ownerId: run.ownerId, repositoryId: run.repositoryId,
      executionId: run.executionId, workerId: "agent-b", leaseMs: 30_000 }, quotas),
  ]);
  assert.equal(new Set(leases.filter(Boolean).map((lease) => lease!.workUnitId)).size, 2);
  const lease = leases[0]!;
  const heartbeat = await store.heartbeat(claim(run, lease), 90_000);
  assert.ok(Date.parse(heartbeat.leaseExpiresAt) > Date.parse(lease.leaseExpiresAt));
});

test("stale lease recovery restores schedulable state and rejects stale tokens", async () => {
  const store = new MemoryRepositoryExecutionStore();
  const run = await createApproved(store);
  const lease = await store.leaseNext({
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    workerId: "agent-a", leaseMs: 10,
  }, quotas);
  assert.ok(lease);
  assert.equal(await store.recover(new Date(Date.now() + 1_000)), 1);
  await assert.rejects(() => store.publishOutput(claim(run, lease!), output, "late", quotas),
    /claim token is stale/);
  await assert.rejects(() => store.heartbeat(claim(run, lease!), 60_000), /claim token is stale/);
});

test("structured output is required, size limited, versioned, and idempotent", async () => {
  const store = new MemoryRepositoryExecutionStore();
  const run = await createApproved(store);
  const lease = await store.leaseNext({
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    workerId: "agent", leaseMs: 60_000,
  }, quotas);
  assert.ok(lease);
  await assert.rejects(() => store.publishOutput(claim(run, lease!), { summary: "" } as AgentWorkUnitOutput,
    "invalid", quotas), /structured agent output/);
  const version = await store.publishOutput(claim(run, lease!), output, "output-1", quotas);
  assert.equal(version, 1);
  assert.equal(await store.publishOutput(claim(run, lease!), output, "output-1", quotas), 1);
  const stored = await store.get(run.ownerId, run.repositoryId, run.executionId);
  assert.equal(stored?.outputs[0]?.outputVersion, 1);
  assert.equal(stored?.workUnits.find((unit) => unit.workUnitId === lease!.workUnitId)?.status, "awaiting_review");
});

test("review approval is output-fenced and changes requested supports bounded retry", async () => {
  const store = new MemoryRepositoryExecutionStore();
  const run = await createApproved(store);
  const lease = await store.leaseNext({
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    workerId: "agent", leaseMs: 60_000,
  }, quotas);
  await store.publishOutput(claim(run, lease!), output, "out", quotas);
  const base = {
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    workUnitId: lease!.workUnitId, reviewerId: "reviewer", reviewerType: "human" as const,
    findings: [], requiredCorrections: [], idempotencyKey: "review",
  };
  await assert.rejects(() => store.submitReview({ ...base, verdict: "approved", reviewedOutputVersion: 0 }),
    /stale output/);
  const review = await store.submitReview({
    ...base, verdict: "changes_requested", reviewedOutputVersion: 1,
    requiredCorrections: ["Add an edge case."],
  });
  assert.equal(review.verdict, "changes_requested");
  assert.equal((await store.get(run.ownerId, run.repositoryId, run.executionId))?.workUnits
    .find((unit) => unit.workUnitId === lease!.workUnitId)?.status, "ready");
});

test("retry exhaustion fails the unit and blocks downstream work without erasing completed units", async () => {
  const store = new MemoryRepositoryExecutionStore();
  const run = prepared({}, { attemptsPerWorkUnit: 1 });
  await store.create(run, "retry", { ...quotas, attemptsPerWorkUnit: 1 });
  await store.approve({
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    executionVersion: run.executionVersion, repositoryRevision: run.repositoryRevision, idempotencyKey: "approve",
  });
  const lease = await store.leaseNext({
    ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
    workerId: "agent", leaseMs: 60_000,
  }, quotas);
  await store.failUnit(claim(run, lease!), "permanent", "Could not prepare proposal.", false);
  const stored = await store.get(run.ownerId, run.repositoryId, run.executionId);
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.workUnits.find((unit) => unit.phaseId === "service")?.status, "blocked");
  assert.equal(stored?.diagnostics[0]?.code, "permanent");
});

test("a run succeeds only after every unit is reviewed successfully or skipped", async () => {
  const store = new MemoryRepositoryExecutionStore();
  const run = await createApproved(store);
  let index = 0;
  while (true) {
    const lease = await store.leaseNext({
      ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
      workerId: `agent-${index}`, leaseMs: 60_000,
    }, quotas);
    if (!lease) break;
    await store.publishOutput(claim(run, lease), output, `output-${index}`, quotas);
    await store.submitReview({
      ownerId: run.ownerId, repositoryId: run.repositoryId, executionId: run.executionId,
      workUnitId: lease.workUnitId, reviewerId: "human", reviewerType: "human",
      verdict: index === 0 ? "skipped" : "approved", findings: [], requiredCorrections: [],
      reviewedOutputVersion: 1, idempotencyKey: `review-${index}`,
    });
    index += 1;
  }
  assert.equal((await store.get(run.ownerId, run.repositoryId, run.executionId))?.status, "succeeded");
});

test("cancellation and supersession invalidate leases and never resume", async () => {
  const store = new MemoryRepositoryExecutionStore();
  const cancelled = await createApproved(store);
  await store.leaseNext({ ownerId: cancelled.ownerId, repositoryId: cancelled.repositoryId,
    executionId: cancelled.executionId, workerId: "agent", leaseMs: 60_000 }, quotas);
  const result = await store.cancel(cancelled.ownerId, cancelled.repositoryId, cancelled.executionId, "cancel");
  assert.equal(result.status, "cancelled");
  assert.equal(result.leases.length, 0);

  const superseded = prepared({ userConstraints: { version: 2 } });
  await store.create(superseded, "superseded", quotas);
  await store.supersede(superseded.ownerId, superseded.repositoryId, superseded.executionId, "Plan changed.");
  assert.equal((await store.get(superseded.ownerId, superseded.repositoryId, superseded.executionId))?.status,
    "superseded");
});

test("owner and repository filters prevent cross-tenant reads, listing, approval, leasing, and review", async () => {
  const store = new MemoryRepositoryExecutionStore();
  const run = await createApproved(store);
  assert.equal(await store.get("user-2", run.repositoryId, run.executionId), null);
  assert.equal((await store.list("user-2", run.repositoryId)).runs.length, 0);
  await assert.rejects(() => store.approve({
    ownerId: "user-2", repositoryId: run.repositoryId, executionId: run.executionId,
    executionVersion: run.executionVersion, repositoryRevision: run.repositoryRevision, idempotencyKey: "x",
  }), /not found/);
  await assert.rejects(() => store.leaseNext({
    ownerId: "user-2", repositoryId: run.repositoryId, executionId: run.executionId,
    workerId: "agent", leaseMs: 1_000,
  }, quotas), /not found/);
});

test("quotas reject excess work units, active runs, leases, outputs, and duration", async () => {
  assert.throws(() => prepareExecutionRun(creation(), { ...quotas, workUnitsPerRun: 1 }),
    /too many work units/);
  const store = new MemoryRepositoryExecutionStore();
  const first = prepared();
  await store.create(first, "one", { ...quotas, activeRunsPerUser: 1 });
  const second = prepared({ userConstraints: { second: true } });
  await assert.rejects(() => store.create(second, "two", { ...quotas, activeRunsPerUser: 1 }),
    /Active execution quota/);
  await store.approve({
    ownerId: first.ownerId, repositoryId: first.repositoryId, executionId: first.executionId,
    executionVersion: first.executionVersion, repositoryRevision: first.repositoryRevision, idempotencyKey: "approve",
  });
  const lease = await store.leaseNext({ ownerId: first.ownerId, repositoryId: first.repositoryId,
    executionId: first.executionId, workerId: "agent", leaseMs: 60_000 }, quotas);
  await assert.rejects(() => store.publishOutput(claim(first, lease!), output, "oversized",
    { ...quotas, outputBytes: 10 }), /size limit/);
});

test("retention and concurrent cleanup preserve active and newest terminal runs", async () => {
  const store = new MemoryRepositoryExecutionStore();
  for (let index = 0; index < 4; index += 1) {
    const run = prepared({ userConstraints: { index } });
    await store.create(run, `create-${index}`, quotas);
    await store.cancel(run.ownerId, run.repositoryId, run.executionId, `cancel-${index}`);
  }
  const active = prepared({ userConstraints: { active: true } });
  await store.create(active, "active", quotas);
  const removed = await Promise.all([
    store.collect(active.ownerId, active.repositoryId, 2),
    store.collect(active.ownerId, active.repositoryId, 2),
  ]);
  assert.ok(removed.reduce((sum, value) => sum + value, 0) >= 2);
  assert.ok(await store.get(active.ownerId, active.repositoryId, active.executionId));
});

test("memory and Supabase stores use equivalent execution records and tenant filters", async () => {
  const run = prepared();
  const memory = new MemoryRepositoryExecutionStore();
  await memory.create(run, "create", quotas);
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => ({
      then: (resolve: (value: unknown) => unknown) => resolve({
        data: name === "get_repository_execution" && args.input_owner_id === run.ownerId
          ? [{ run }] : [],
        error: null,
      }),
    }),
  };
  const postgres = new SupabaseRepositoryExecutionStore(client as never);
  assert.deepEqual(await postgres.get(run.ownerId, run.repositoryId, run.executionId),
    await memory.get(run.ownerId, run.repositoryId, run.executionId));
  assert.equal(await postgres.get("other", run.repositoryId, run.executionId), null);
});

test("startup validation verifies schema, lease, review, idempotency, retention, and policy contract", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = {
    rpc: (name: string, args: unknown) => {
      calls.push({ name, args });
      return { then: (resolve: (value: unknown) => unknown) =>
        resolve({ data: [{ valid: true, problems: [] }], error: null }) };
    },
  };
  await new SupabaseRepositoryExecutionStore(client as never).verify();
  assert.equal(calls[0]?.name, "verify_repository_execution_contract");
  assert.equal((calls[0]?.args as Record<string, unknown>).input_orchestrator_version,
    "repository-execution-v1");
});

test("migration defines durable tables, indexes, constraints, fencing RPCs, RLS, grants, and retention", async () => {
  const migration = await readFile(
    new URL("../../supabase/migrations/20260808000000_add_repository_execution_orchestrator.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "repository_execution_versions", "repository_executions", "repository_execution_work_units",
    "repository_execution_work_unit_dependencies", "repository_execution_approvals",
    "repository_execution_work_unit_leases", "repository_execution_agent_outputs",
    "repository_execution_reviews", "repository_execution_idempotency", "repository_execution_diagnostics",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
  }
  for (const contract of [
    "lease_repository_execution_work_unit", "heartbeat_repository_execution_work_unit",
    "publish_repository_execution_output", "submit_repository_execution_review",
    "recover_repository_execution_leases", "collect_repository_executions",
    "verify_repository_execution_contract",
  ]) assert.match(migration, new RegExp(contract));
  assert.match(migration, /enable row level security/);
  assert.match(migration, /grant execute[\s\S]+to service_role/);
  assert.match(migration, /claim_token text not null unique/);
  assert.match(migration, /reviewed_output_version/);
  assert.match(migration, /execution_idempotency_conflict/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test("execution metrics expose the complete observability contract", () => {
  const metrics = new MetricsRegistry();
  metrics.recordRepositoryExecution({
    created: 1, approvals: 2, activeRuns: 3, readyUnits: 4, blockedUnits: 5,
    runningUnits: 6, leaseRecoveries: 7, retries: 8, failures: 9,
    reviewLatencyMs: 10, runDurationMs: 11, criticalPathDurationMs: 12,
  });
  const rendered = metrics.render();
  for (const expectation of [
    "giro_repository_execution_runs_created_total 1",
    "giro_repository_execution_approvals_total 2",
    "giro_repository_execution_active_runs 3",
    "giro_repository_execution_ready_units 4",
    "giro_repository_execution_blocked_units 5",
    "giro_repository_execution_running_units 6",
    "giro_repository_execution_lease_recoveries_total 7",
    "giro_repository_execution_retries_total 8",
    "giro_repository_execution_failures_total 9",
    "giro_repository_execution_review_latency_ms_total 10",
    "giro_repository_execution_run_duration_ms_total 11",
    "giro_repository_execution_critical_path_duration_ms_total 12",
  ]) assert.match(rendered, new RegExp(expectation));
});
