import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { analyzeRepositoryIntelligence } from "../services/repositoryIntelligence/analyzer.js";
import type { RepositoryIntelligenceRecord } from "../services/repositoryIntelligence/types.js";
import type {
  RepositoryGraphEdge,
  RepositoryGraphNode,
  RepositorySymbolGraph,
} from "../services/repositoryGraph/graphTypes.js";
import { planDependencies } from "../services/repositoryPlanning/dependencyPlanner.js";
import { buildRepositoryPlan } from "../services/repositoryPlanning/planner.js";
import { scorePlanRisk } from "../services/repositoryPlanning/riskEngine.js";
import {
  MemoryRepositoryPlanningStore,
  SupabaseRepositoryPlanningStore,
} from "../services/repositoryPlanning/store.js";
import type {
  RepositoryExecutionPlan,
  RepositoryPlanningInput,
} from "../services/repositoryPlanning/types.js";
import { validateRepositoryPlan } from "../services/repositoryPlanning/validation.js";
import { createRepositoryPlanIdentity } from "../services/repositoryPlanning/version.js";
import { MetricsRegistry } from "../observability/metrics.js";

function node(
  revision: string,
  graphVersion: string,
  input: Partial<RepositoryGraphNode> & Pick<RepositoryGraphNode, "nodeId" | "file" | "name">,
): RepositoryGraphNode {
  return {
    symbolId: input.nodeId,
    graphVersion,
    repositoryId: "acme/widgets",
    repositoryRevision: revision,
    repositoryVersion: revision,
    parserVersion: "typescript-compiler-v1",
    qualifiedName: `${input.file}:${input.name}`,
    kind: "function",
    language: "typescript",
    line: 1,
    endLine: 10,
    column: 1,
    endColumn: 1,
    exported: false,
    defaultExport: false,
    metadata: {},
    ...input,
  };
}

function edge(
  revision: string,
  graphVersion: string,
  edgeId: string,
  fromNodeId: string,
  toNodeId: string,
  kind: RepositoryGraphEdge["kind"] = "imports",
): RepositoryGraphEdge {
  return {
    edgeId,
    graphVersion,
    repositoryId: "acme/widgets",
    repositoryRevision: revision,
    parserVersion: "typescript-compiler-v1",
    fromNodeId,
    toNodeId,
    fromSymbolId: fromNodeId,
    toSymbolId: toNodeId,
    kind,
    distance: 1,
    metadata: {},
  };
}

function fixture(options: {
  revision?: string;
  cycle?: boolean;
  retrieval?: boolean;
  task?: string;
} = {}): RepositoryPlanningInput {
  const revision = options.revision ?? "rev-1";
  const graphVersion = `graph-${revision}`;
  const embeddingVersion = `embedding-${revision}`;
  const nodes = [
    node(revision, graphVersion, {
      nodeId: "api",
      file: "src/api/widgetRoute.ts",
      name: "createWidget",
      exported: true,
    }),
    node(revision, graphVersion, {
      nodeId: "service",
      file: "src/services/widgetService.ts",
      name: "WidgetService",
      exported: true,
    }),
    node(revision, graphVersion, {
      nodeId: "database",
      file: "src/database/widgetStore.ts",
      name: "WidgetStore",
      exported: true,
    }),
    node(revision, graphVersion, {
      nodeId: "unrelated",
      file: "src/health/check.ts",
      name: "healthCheck",
    }),
  ];
  const edges = [
    edge(revision, graphVersion, "api-service", "api", "service", "calls"),
    edge(revision, graphVersion, "service-database", "service", "database", "imports"),
    ...(options.cycle
      ? [edge(revision, graphVersion, "database-service", "database", "service", "calls")]
      : []),
  ];
  const snapshot = analyzeRepositoryIntelligence({
    repositoryId: "acme/widgets",
    repositoryRevision: revision,
    graphVersion,
    embeddingVersion,
    parserVersion: "typescript-compiler-v1",
    nodes,
    edges,
    files: nodes.map((item) => ({ filePath: item.file, size: 1_000 })),
    changedFiles: [],
  });
  const intelligence: RepositoryIntelligenceRecord = {
    ...snapshot,
    status: "published",
    createdAt: "created",
    validatedAt: "validated",
    publishedAt: "published",
    publicationMetadata: {
      repositoryRevision: revision,
      graphVersion,
      embeddingVersion,
      previousIntelligenceVersion: null,
    },
  };
  const graph: RepositorySymbolGraph = {
    graphVersion,
    repositoryId: "acme/widgets",
    repositoryRevision: revision,
    repositoryVersion: revision,
    parserVersion: "typescript-compiler-v1",
    status: "published",
    createdAt: "created",
    publishedAt: "published",
    nodes,
    edges,
    diagnostics: {
      parsedFileCount: 4,
      parserFailureCount: 0,
      unresolvedImportCount: 0,
      importCount: edges.length,
      unresolvedFileRatio: 0,
      parserFailureRatio: 0,
      orphanSymbolCount: 0,
      duplicateNodeIdCount: 0,
      duplicateEdgeIdCount: 0,
      missingEndpointCount: 0,
      impossibleSelfEdgeCount: 0,
      graphBytes: 1_000,
      durationMs: 1,
      failures: [],
    },
  };
  return {
    repositoryId: "acme/widgets",
    repositoryRevision: revision,
    userTask: options.task ?? "Add widget database migration support",
    intelligence,
    graph,
    embeddingVersion,
    retrievalResults: options.retrieval === false ? [] : [{
      repository: "acme/widgets",
      filePath: "src/api/widgetRoute.ts",
      language: "typescript",
      content: "export function createWidget() {}",
      startLine: 1,
      endLine: 3,
      score: 0.9,
      source: "semantic",
      signals: { semantic: 0.9 },
      chunkId: "route",
      symbol: "createWidget",
    }],
    repositoryStatistics: { files: 4, symbols: 4, dependencyEdges: edges.length },
    repositoryHistory: [],
  };
}

function context(input: RepositoryPlanningInput) {
  return {
    knownFiles: [...new Set(input.graph.nodes.map((item) => item.file))].sort(),
    knownNodeIds: [...new Set(input.graph.nodes.map((item) => item.nodeId))].sort(),
  };
}

async function publish(
  store: MemoryRepositoryPlanningStore,
  input: RepositoryPlanningInput,
) {
  const plan = buildRepositoryPlan(input);
  await store.begin(createRepositoryPlanIdentity(input));
  await store.stage(plan, context(input));
  assert.equal((await store.validate(plan.planVersion)).valid, true);
  await store.publish(plan.planVersion);
  return plan;
}

test("planning is deterministic and produces complete structured execution output", () => {
  const input = fixture();
  const first = buildRepositoryPlan(input);
  const second = buildRepositoryPlan(structuredClone(input));
  assert.deepEqual(second, first);
  assert.equal(first.objective, "Add widget database migration support");
  assert.ok(first.affectedSubsystems.length > 0);
  assert.ok(first.affectedFiles.length > 0);
  assert.ok(first.affectedSymbols.some((symbol) => symbol.qualifiedName.includes("WidgetStore")));
  assert.ok(first.implementationPhases.length > 1);
  assert.equal(first.migrationRequirements.required, true);
  assert.ok(first.validationSteps.some((step) => step.kind === "migration"));
  assert.ok(first.testingStrategy.regression.includes("existing-api-contracts"));
  assert.equal(first.rollbackStrategy.phaseOrder[0], first.implementationPhases.at(-1)?.phaseId);
  assert.ok(first.confidenceScore >= 0 && first.confidenceScore <= 1);
});

test("dependency planner orders prerequisites first and identifies independent work", () => {
  const input = fixture({ retrieval: false });
  const result = planDependencies({
    affectedFiles: input.graph.nodes.map((item) => item.file),
    nodes: input.graph.nodes,
    edges: input.graph.edges,
    subsystemDependencies: [],
    subsystemForFile: new Map(),
  });
  assert.ok(result.orderedFiles.indexOf("src/database/widgetStore.ts") <
    result.orderedFiles.indexOf("src/services/widgetService.ts"));
  assert.ok(result.orderedFiles.indexOf("src/services/widgetService.ts") <
    result.orderedFiles.indexOf("src/api/widgetRoute.ts"));
  assert.ok(result.independentWork[0]?.includes("src/health/check.ts"));
  assert.equal(result.blockingDependencies.length, 2);
});

test("cycles are detected and collapsed into a valid circular implementation phase", () => {
  const input = fixture({ cycle: true });
  const plan = buildRepositoryPlan(input);
  assert.deepEqual(plan.dependencyOrder.circularPlans, [[
    "src/database/widgetStore.ts",
    "src/services/widgetService.ts",
  ]]);
  assert.ok(plan.implementationPhases.some((phase) => phase.files.length === 2));
  assert.equal(validateRepositoryPlan(plan, context(input)).valid, true);
});

test("validation rejects duplicate phases, impossible dependencies, cycles, missing inputs, bad ordering, and risk", () => {
  const input = fixture();
  const plan = buildRepositoryPlan(input);
  const duplicate = structuredClone(plan.implementationPhases[0]!);
  plan.implementationPhases.push(duplicate);
  plan.implementationPhases[0]!.dependsOn = ["missing-phase"];
  plan.implementationPhases[1]!.dependsOn = [
    ...plan.implementationPhases[1]!.dependsOn,
    plan.implementationPhases[0]!.phaseId,
  ];
  plan.implementationPhases[0]!.dependsOn.push(plan.implementationPhases[1]!.phaseId);
  plan.affectedFiles.push({ path: "missing.ts", reasons: [], retrievalScore: null });
  plan.affectedSymbols.push({
    nodeId: "missing-symbol",
    qualifiedName: "missing",
    file: "missing.ts",
    kind: "function",
    publicApi: false,
  });
  plan.riskAnalysis.overallRisk = 2;
  const validation = validateRepositoryPlan(plan, context(input), plan.planVersion, "validated");
  const codes = new Set(validation.diagnostics.map((item) => item.code));
  for (const code of [
    "duplicate_phase",
    "impossible_dependency",
    "circular_plan",
    "missing_file",
    "missing_symbol",
    "invalid_ordering",
    "inconsistent_risk",
    "cyclic_publication_metadata",
  ]) assert.equal(codes.has(code), true, code);
});

test("risk scoring increases for broad public migration plans", () => {
  const low = scorePlanRisk({
    affectedFileCount: 1,
    repositoryFileCount: 100,
    affectedSubsystemCount: 1,
    repositorySubsystemCount: 10,
    dependencyCount: 0,
    circularPlanCount: 0,
    publicApiCount: 0,
    migrationRequired: false,
    phaseCount: 1,
    validationCount: 2,
  });
  const high = scorePlanRisk({
    affectedFileCount: 80,
    repositoryFileCount: 100,
    affectedSubsystemCount: 9,
    repositorySubsystemCount: 10,
    dependencyCount: 40,
    circularPlanCount: 2,
    publicApiCount: 20,
    migrationRequired: true,
    phaseCount: 10,
    validationCount: 2,
  });
  assert.ok(high.overallRisk > low.overallRisk);
  assert.ok(["high", "critical"].includes(high.level));
});

test("retrieval enriches scope without replacing graph dependency ordering", () => {
  const without = buildRepositoryPlan(fixture({
    retrieval: false,
    task: "Improve health behavior",
  }));
  const withRetrievalInput = fixture({
    retrieval: true,
    task: "Improve health behavior",
  });
  const withRetrieval = buildRepositoryPlan(withRetrievalInput);
  assert.equal(withRetrieval.retrievalContribution.used, true);
  assert.ok(withRetrieval.affectedFiles.some((file) => file.path === "src/api/widgetRoute.ts"));
  assert.ok(withRetrieval.dependencyOrder.orderedFiles.indexOf("src/services/widgetService.ts") <
    withRetrieval.dependencyOrder.orderedFiles.indexOf("src/api/widgetRoute.ts"));
  assert.ok(withRetrieval.affectedFiles.length >= without.affectedFiles.length);
});

test("publication, rollback preservation, restart recovery, and retention are safe", async () => {
  const store = new MemoryRepositoryPlanningStore();
  const firstInput = fixture();
  const first = await publish(store, firstInput);
  assert.equal((await store.loadPublished(first.repositoryId, first.taskHash))?.planVersion, first.planVersion);

  const secondInput = fixture({ revision: "rev-2" });
  const second = buildRepositoryPlan(secondInput);
  await store.begin(createRepositoryPlanIdentity(secondInput));
  await store.stage(second, context(secondInput));
  await store.validate(second.planVersion);
  assert.equal((await store.loadPublished(first.repositoryId, first.taskHash))?.planVersion, first.planVersion);
  await store.publish(second.planVersion);
  assert.equal((await store.loadPublished(second.repositoryId, second.taskHash))?.planVersion, second.planVersion);

  const thirdInput = fixture({ revision: "rev-3" });
  await store.begin(createRepositoryPlanIdentity(thirdInput));
  assert.equal(await store.recover(), 1);
  assert.equal((await store.loadPublished(second.repositoryId, second.taskHash))?.planVersion, second.planVersion);
  await Promise.all([
    store.collect(second.repositoryId, second.taskHash, 2),
    store.collect(second.repositoryId, second.taskHash, 2),
  ]);
  await store.verify();
});

test("memory and Supabase planning stores return equivalent published records", async () => {
  const memory = new MemoryRepositoryPlanningStore();
  const plan = await publish(memory, fixture());
  const record = await memory.loadPublished(plan.repositoryId, plan.taskHash);
  assert.ok(record);
  const client = {
    rpc: (name: string) => ({
      then: (resolve: (value: unknown) => unknown) => resolve({
        data: name === "get_published_repository_plan" ? [{
          plan: { ...record, status: undefined, createdAt: undefined, validatedAt: undefined,
            publishedAt: undefined, publicationMetadata: undefined },
          status: record.status,
          publication_metadata: record.publicationMetadata,
          created_at: record.createdAt,
          validated_at: record.validatedAt,
          published_at: record.publishedAt,
        }] : null,
        error: null,
      }),
    }),
  };
  const postgres = new SupabaseRepositoryPlanningStore(client as never);
  assert.deepEqual(await postgres.loadPublished(plan.repositoryId, plan.taskHash), record);
});

test("startup validation checks the PostgreSQL planning contract version", async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = {
    rpc: (name: string, args: unknown) => {
      calls.push({ name, args });
      return {
        then: (resolve: (value: unknown) => unknown) => resolve({
          data: name === "verify_repository_planning_contract" ? [{
            valid: true,
            problems: [],
          }] : null,
          error: null,
        }),
      };
    },
  };
  await new SupabaseRepositoryPlanningStore(client as never).verify();
  assert.deepEqual(calls, [{
    name: "verify_repository_planning_contract",
    args: { input_planner_version: "repository-planner-v1" },
  }]);
});

test("planning migration defines lifecycle, atomic publication, RLS, grants, validation, and retention", async () => {
  const migration = await readFile(
    new URL("../../supabase/migrations/20260807000000_add_repository_planning_engine.sql", import.meta.url),
    "utf8",
  );
  for (const table of [
    "repository_plan_versions",
    "repository_plans",
    "repository_plan_diagnostics",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /status in \('building', 'validating', 'published', 'failed', 'superseded'\)/);
  assert.match(migration, /publish_repository_plan_version/);
  assert.match(migration, /repository_plan_publication_in_progress/);
  assert.match(migration, /duplicate_phase/);
  assert.match(migration, /circular_plan/);
  assert.match(migration, /missing_symbol/);
  assert.match(migration, /inconsistent_risk/);
  assert.match(migration, /rollback_plan_version/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /verify_repository_planning_contract/);
  assert.match(migration, /grant execute[\s\S]+to service_role/);
});

test("planning metrics track duration, phases, dependencies, risk, failures, and retrieval contribution", () => {
  const metrics = new MetricsRegistry();
  metrics.recordRepositoryPlanning({
    durationMs: 25,
    phaseCount: 4,
    dependencyCount: 3,
    riskScore: 0.5,
    retrievalContribution: 2,
  });
  metrics.incrementRepositoryPlannerFailures();
  const rendered = metrics.render();
  assert.match(rendered, /giro_repository_planning_duration_ms_total 25/);
  assert.match(rendered, /giro_repository_planning_phases_total 4/);
  assert.match(rendered, /giro_repository_planning_dependencies_total 3/);
  assert.match(rendered, /giro_repository_planning_risk_score_total 0.5/);
  assert.match(rendered, /giro_repository_planner_failures_total 1/);
  assert.match(rendered, /giro_repository_planning_retrieval_contribution_total 2/);
});
