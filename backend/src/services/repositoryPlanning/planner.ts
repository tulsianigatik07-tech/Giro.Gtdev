import { createHash } from "node:crypto";
import type { RepositoryGraphNode } from "../repositoryGraph/graphTypes.js";
import { planDependencies } from "./dependencyPlanner.js";
import { scorePlanRisk } from "./riskEngine.js";
import type {
  ImplementationPhase,
  RepositoryExecutionPlan,
  RepositoryPlanningInput,
} from "./types.js";
import { normalizePlanningTask, createRepositoryPlanIdentity } from "./version.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "into",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "with",
  "add", "change", "create", "fix", "implement", "make", "update",
]);
const MIGRATION = /\b(database|schema|migration|migrate|column|table|index|rls|grant)\b/iu;
const TEST_FILE = /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./u;

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function tokens(value: string): string[] {
  return sortedUnique(value.toLowerCase().split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
}

function matchesTask(value: string, taskTokens: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return taskTokens.some((token) => normalized.includes(token));
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function subsystemMap(input: RepositoryPlanningInput): Map<string, string> {
  return new Map(input.intelligence.subsystems.flatMap((subsystem) =>
    subsystem.files.map((file) => [file, subsystem.subsystemId] as const)));
}

function selectAffectedFiles(input: RepositoryPlanningInput): {
  files: string[];
  reasons: Map<string, Set<string>>;
  retrievalScores: Map<string, number>;
} {
  const taskTokens = tokens(input.userTask);
  const knownFiles = sortedUnique([
    ...input.graph.nodes.map((node) => node.file).filter(Boolean),
    ...input.intelligence.subsystems.flatMap((subsystem) => subsystem.files),
  ]);
  const reasons = new Map<string, Set<string>>();
  const retrievalScores = new Map<string, number>();
  const add = (file: string, reason: string) => {
    if (!knownFiles.includes(file)) return;
    const entries = reasons.get(file) ?? new Set<string>();
    entries.add(reason);
    reasons.set(file, entries);
  };
  for (const file of knownFiles) if (matchesTask(file, taskTokens)) add(file, "task_path_match");
  for (const node of input.graph.nodes) {
    if (matchesTask(`${node.name} ${node.qualifiedName}`, taskTokens)) add(node.file, "task_symbol_match");
  }
  for (const result of [...input.retrievalResults].sort((a, b) =>
    b.score - a.score || a.filePath.localeCompare(b.filePath))) {
    if (result.repository !== input.repositoryId || !knownFiles.includes(result.filePath)) continue;
    add(result.filePath, "retrieval_evidence");
    retrievalScores.set(
      result.filePath,
      Math.max(retrievalScores.get(result.filePath) ?? 0, Math.max(0, Math.min(1, result.score))),
    );
  }
  if (reasons.size === 0) {
    for (const file of [
      ...input.intelligence.symbols.entrypoints,
      ...input.intelligence.architecture.hotspots.slice(0, 5).map((item) => item.path),
    ]) add(file, "repository_structure_fallback");
  }
  const nodeFile = new Map(input.graph.nodes.map((node) => [node.nodeId, node.file]));
  const selected = new Set(reasons.keys());
  for (const edge of input.graph.edges) {
    if (!["imports", "calls", "extends", "implements", "re_exports"].includes(edge.kind)) continue;
    const from = nodeFile.get(edge.fromNodeId);
    const to = nodeFile.get(edge.toNodeId);
    if (!from || !to || from === to) continue;
    if (selected.has(from)) add(to, "graph_dependency");
    if (selected.has(to)) add(from, "graph_dependent");
  }
  return { files: [...reasons.keys()].sort(), reasons, retrievalScores };
}

function affectedSymbols(
  nodes: readonly RepositoryGraphNode[],
  files: ReadonlySet<string>,
  taskTokens: readonly string[],
) {
  return [...nodes].filter((node) =>
    files.has(node.file) &&
    node.kind !== "file" &&
    node.kind !== "module" &&
    node.kind !== "imported_member" &&
    (node.exported || matchesTask(`${node.name} ${node.qualifiedName}`, taskTokens)))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.nodeId.localeCompare(b.nodeId))
    .map((node) => ({
      nodeId: node.nodeId,
      qualifiedName: node.qualifiedName,
      file: node.file,
      kind: node.kind,
      publicApi: node.exported,
    }));
}

function buildPhases(input: {
  files: readonly string[];
  symbols: ReturnType<typeof affectedSymbols>;
  dependencies: ReturnType<typeof planDependencies>;
  subsystemForFile: ReadonlyMap<string, string>;
  migrationRequired: boolean;
}): ImplementationPhase[] {
  const circularByFile = new Map<string, string[]>();
  for (const cycle of input.dependencies.circularPlans) {
    for (const file of cycle) circularByFile.set(file, cycle);
  }
  const groupKey = (file: string) => (circularByFile.get(file) ?? [file]).join("\0");
  const groups = new Map<string, string[]>();
  for (const file of input.files) groups.set(groupKey(file), circularByFile.get(file) ?? [file]);
  const phaseByFile = new Map<string, string>();
  const phases = [...groups.values()].sort((left, right) =>
    Math.min(...left.map((file) => input.dependencies.orderByFile.get(file) ?? Number.MAX_SAFE_INTEGER)) -
      Math.min(...right.map((file) => input.dependencies.orderByFile.get(file) ?? Number.MAX_SAFE_INTEGER)) ||
    left[0]!.localeCompare(right[0]!),
  ).map((files, index): ImplementationPhase => {
    const phaseId = `phase:${shortHash(files.join("\0"))}`;
    files.forEach((file) => phaseByFile.set(file, phaseId));
    return {
      phaseId,
      order: index + (input.migrationRequired ? 1 : 0),
      name: files.length > 1 ? `circular-component:${files[0]}` : `implement:${files[0]}`,
      kind: "implementation",
      subsystemIds: sortedUnique(files.flatMap((file) => {
        const subsystem = input.subsystemForFile.get(file);
        return subsystem ? [subsystem] : [];
      })),
      files: [...files].sort(),
      symbols: input.symbols.filter((symbol) => files.includes(symbol.file))
        .map((symbol) => symbol.nodeId),
      dependsOn: [],
      operations: ["modify", "preserve_contracts"],
      independentlyExecutable: false,
    };
  });
  const byId = new Map(phases.map((phase) => [phase.phaseId, phase]));
  for (const dependency of input.dependencies.dependencies) {
    const dependentPhase = phaseByFile.get(dependency.fromFile);
    const prerequisitePhase = phaseByFile.get(dependency.toFile);
    if (!dependentPhase || !prerequisitePhase || dependentPhase === prerequisitePhase) continue;
    const phase = byId.get(dependentPhase)!;
    phase.dependsOn = sortedUnique([...phase.dependsOn, prerequisitePhase]);
  }
  for (const phase of phases) phase.independentlyExecutable = phase.dependsOn.length === 0;
  if (input.migrationRequired) {
    const migrationPhaseId = "phase:migration";
    phases.unshift({
      phaseId: migrationPhaseId,
      order: 0,
      name: "prepare:migration",
      kind: "migration",
      subsystemIds: sortedUnique(phases.flatMap((phase) => phase.subsystemIds)),
      files: input.files.filter((file) => MIGRATION.test(file)),
      symbols: [],
      dependsOn: [],
      operations: ["add_forward_migration", "add_rollback_migration"],
      independentlyExecutable: true,
    });
    for (const phase of phases.slice(1)) phase.dependsOn = sortedUnique([...phase.dependsOn, migrationPhaseId]);
  }
  return phases.map((phase, index) => ({ ...phase, order: index }));
}

export function buildRepositoryPlan(input: RepositoryPlanningInput): RepositoryExecutionPlan {
  if (!normalizePlanningTask(input.userTask)) throw new Error("Planning task is required.");
  if (input.repositoryRevision !== input.intelligence.repositoryRevision ||
      input.repositoryRevision !== input.graph.repositoryRevision ||
      input.embeddingVersion !== input.intelligence.embeddingVersion ||
      input.graph.graphVersion !== input.intelligence.graphVersion) {
    throw new Error("Repository planning inputs are version-incompatible.");
  }
  const identity = createRepositoryPlanIdentity(input);
  const taskTokens = tokens(input.userTask);
  const selection = selectAffectedFiles(input);
  const affectedFileSet = new Set(selection.files);
  const subsystemForFile = subsystemMap(input);
  const symbols = affectedSymbols(input.graph.nodes, affectedFileSet, taskTokens);
  const dependencies = planDependencies({
    affectedFiles: selection.files,
    nodes: input.graph.nodes,
    edges: input.graph.edges,
    subsystemDependencies: input.intelligence.architecture.dependencyGraph,
    subsystemForFile,
  });
  const migrationFiles = selection.files.filter((file) =>
    /(^|\/)(migrations?|schema|database)(\/|$)|\.sql$/iu.test(file));
  const migrationRequired = MIGRATION.test(input.userTask) || migrationFiles.length > 0;
  const phases = buildPhases({
    files: selection.files,
    symbols,
    dependencies,
    subsystemForFile,
    migrationRequired,
  });
  const validationSteps: RepositoryExecutionPlan["validationSteps"] = [
    { validationId: "static:typecheck", kind: "static", command: "pnpm typecheck", required: true },
    { validationId: "test:unit", kind: "test", command: "pnpm test", required: true },
  ];
  if (dependencies.dependencies.length > 0) {
    validationSteps.push({
      validationId: "integration:dependencies",
      kind: "integration",
      command: "validate dependency integration",
      required: true,
    });
  }
  if (migrationRequired) {
    validationSteps.push({
      validationId: "migration:verify",
      kind: "migration",
      command: "pnpm verify:migrations",
      required: true,
    });
  }
  const affectedSubsystems = sortedUnique(selection.files.flatMap((file) => {
    const subsystem = subsystemForFile.get(file);
    return subsystem ? [subsystem] : [];
  }));
  const risks = scorePlanRisk({
    affectedFileCount: selection.files.length,
    repositoryFileCount: input.repositoryStatistics.files,
    affectedSubsystemCount: affectedSubsystems.length,
    repositorySubsystemCount: input.intelligence.subsystems.length,
    dependencyCount: dependencies.dependencies.length,
    circularPlanCount: dependencies.circularPlans.length,
    publicApiCount: symbols.filter((symbol) => symbol.publicApi).length,
    migrationRequired,
    phaseCount: phases.length,
    validationCount: validationSteps.length,
  });
  const retrievalFileCount = selection.files.filter((file) => selection.retrievalScores.has(file)).length;
  const graphCoverage = selection.files.length === 0 ? 0 :
    selection.files.filter((file) => input.graph.nodes.some((node) => node.file === file)).length /
      selection.files.length;
  const subsystemCoverage = selection.files.length === 0 ? 0 :
    selection.files.filter((file) => subsystemForFile.has(file)).length / selection.files.length;
  const confidenceScore = Math.max(0, Math.min(1,
    graphCoverage * 0.45 +
    subsystemCoverage * 0.3 +
    (retrievalFileCount > 0 ? 0.15 : 0.05) +
    (dependencies.circularPlans.length === 0 ? 0.1 : 0.05),
  ));
  const failureHistory = input.repositoryHistory.filter((record) =>
    "eventType" in record && /fail/iu.test(record.eventType)).length;
  return {
    ...identity,
    objective: normalizePlanningTask(input.userTask),
    assumptions: sortedUnique([
      "published_repository_inputs",
      "preserve_existing_api_contracts",
      ...(input.retrievalResults.length > 0 ? ["retrieval_is_advisory"] : ["retrieval_unavailable"]),
      ...(failureHistory > 0 ? ["repository_has_failure_history"] : []),
    ]),
    affectedSubsystems,
    affectedFiles: selection.files.map((path) => ({
      path,
      reasons: [...(selection.reasons.get(path) ?? [])].sort(),
      retrievalScore: selection.retrievalScores.get(path) ?? null,
    })),
    affectedSymbols: symbols,
    dependencyOrder: {
      dependencies: dependencies.dependencies,
      orderedFiles: dependencies.orderedFiles,
      independentWork: dependencies.independentWork,
      blockingDependencies: dependencies.blockingDependencies,
      circularPlans: dependencies.circularPlans,
    },
    implementationPhases: phases,
    validationSteps,
    testingStrategy: {
      unit: sortedUnique(selection.files.filter((file) => !TEST_FILE.test(file))
        .map((file) => `unit:${file}`)),
      integration: dependencies.dependencies.length > 0
        ? ["dependency-boundary-integration"] : [],
      regression: [
        "existing-api-contracts",
        ...(migrationRequired ? ["migration-forward-and-rollback"] : []),
      ],
    },
    migrationRequirements: {
      required: migrationRequired,
      reasons: sortedUnique([
        ...(MIGRATION.test(input.userTask) ? ["task_requires_schema_change"] : []),
        ...(migrationFiles.length > 0 ? ["affected_migration_files"] : []),
      ]),
      affectedFiles: migrationFiles,
      reversible: true,
    },
    rollbackStrategy: {
      phaseOrder: phases.map((phase) => phase.phaseId).reverse(),
      preserveData: true,
      actions: [
        "restore_previous_plan_version",
        "revert_phases_in_reverse_dependency_order",
        ...(migrationRequired ? ["apply_rollback_migration"] : []),
      ],
    },
    riskAnalysis: risks,
    confidenceScore,
    retrievalContribution: {
      used: retrievalFileCount > 0,
      candidateCount: input.retrievalResults.length,
      affectedFileCount: retrievalFileCount,
      maximumScore: Math.max(0, ...selection.retrievalScores.values()),
    },
    inputStatistics: {
      repositoryFiles: input.repositoryStatistics.files,
      repositorySymbols: input.repositoryStatistics.symbols,
      dependencyEdges: input.repositoryStatistics.dependencyEdges,
      historyRecords: input.repositoryHistory.length,
    },
  };
}
