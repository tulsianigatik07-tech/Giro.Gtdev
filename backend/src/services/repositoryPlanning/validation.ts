import { riskValuesConsistent } from "./riskEngine.js";
import type {
  RepositoryExecutionPlan,
  RepositoryPlanDiagnostic,
  RepositoryPlanRecord,
  RepositoryPlanValidation,
  RepositoryPlanValidationContext,
} from "./types.js";
import { REPOSITORY_PLAN_SCHEMA_VERSION, REPOSITORY_PLANNER_VERSION } from "./types.js";

function hasCycle(phases: ReadonlyMap<string, readonly string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (phase: string): boolean => {
    if (visiting.has(phase)) return true;
    if (visited.has(phase)) return false;
    visiting.add(phase);
    for (const dependency of phases.get(phase) ?? []) if (visit(dependency)) return true;
    visiting.delete(phase);
    visited.add(phase);
    return false;
  };
  return [...phases.keys()].some(visit);
}

export function validateRepositoryPlan(
  plan: RepositoryExecutionPlan,
  context: RepositoryPlanValidationContext,
  previousPlanVersion: string | null = null,
  validatedAt = new Date().toISOString(),
): RepositoryPlanValidation {
  const diagnostics: RepositoryPlanDiagnostic[] = [];
  const add = (code: string, message: string, path?: string) =>
    diagnostics.push({ code, message, ...(path ? { path } : {}) });
  if (plan.plannerVersion !== REPOSITORY_PLANNER_VERSION ||
      plan.schemaVersion !== REPOSITORY_PLAN_SCHEMA_VERSION) {
    add("planner_version_incompatible", "Planner or schema version is incompatible.");
  }
  const phaseIds = plan.implementationPhases.map((phase) => phase.phaseId);
  if (new Set(phaseIds).size !== phaseIds.length) {
    add("duplicate_phase", "Implementation phase IDs must be unique.");
  }
  const knownPhases = new Set(phaseIds);
  const phaseDependencies = new Map<string, string[]>();
  for (const phase of plan.implementationPhases) {
    phaseDependencies.set(
      phase.phaseId,
      [...new Set([...(phaseDependencies.get(phase.phaseId) ?? []), ...phase.dependsOn])],
    );
    for (const dependency of phase.dependsOn) {
      if (!knownPhases.has(dependency) || dependency === phase.phaseId) {
        add("impossible_dependency", "Phase dependency is missing or self-referential.", dependency);
      }
      const dependencyPhase = plan.implementationPhases.find((item) => item.phaseId === dependency);
      if (dependencyPhase && dependencyPhase.order >= phase.order) {
        add("invalid_ordering", "A phase appears before its prerequisite.", phase.phaseId);
      }
    }
  }
  if (hasCycle(phaseDependencies)) add("circular_plan", "Implementation phases contain a dependency cycle.");
  const knownFiles = new Set(context.knownFiles);
  for (const file of plan.affectedFiles) {
    if (!knownFiles.has(file.path)) add("missing_file", "Affected file is absent from the repository graph.", file.path);
  }
  const affectedFileSet = new Set(plan.affectedFiles.map((file) => file.path));
  const knownSymbols = new Set(context.knownNodeIds);
  for (const symbol of plan.affectedSymbols) {
    if (!knownSymbols.has(symbol.nodeId)) add("missing_symbol", "Affected symbol is absent from the graph.", symbol.nodeId);
    if (!affectedFileSet.has(symbol.file)) add("missing_file", "Affected symbol references an unaffected file.", symbol.file);
  }
  if (!riskValuesConsistent(plan.riskAnalysis)) {
    add("inconsistent_risk", "Risk values must be finite values between zero and one.");
  }
  if (!Number.isFinite(plan.confidenceScore) || plan.confidenceScore < 0 || plan.confidenceScore > 1) {
    add("inconsistent_confidence", "Confidence score must be between zero and one.");
  }
  if (previousPlanVersion === plan.planVersion) {
    add("cyclic_publication_metadata", "A plan publication cannot roll back to itself.");
  }
  return { valid: diagnostics.length === 0, diagnostics, validatedAt };
}

export function verifyPlanPublicationIntegrity(records: readonly RepositoryPlanRecord[]): void {
  const publishedKeys = new Set<string>();
  for (const record of records.filter((item) => item.status === "published")) {
    const key = `${record.repositoryId}\0${record.taskHash}`;
    if (publishedKeys.has(key)) throw new Error("Repository planning has multiple current publications.");
    publishedKeys.add(key);
    if (record.publicationMetadata.previousPlanVersion === record.planVersion) {
      throw new Error("Repository planning publication metadata is cyclic.");
    }
  }
}
