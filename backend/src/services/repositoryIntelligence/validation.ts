import type {
  RepositoryIntelligenceDiagnostic,
  RepositoryIntelligenceRecord,
  RepositoryIntelligenceSnapshot,
  RepositoryIntelligenceValidation,
} from "./types.js";
import {
  REPOSITORY_INTELLIGENCE_ANALYSIS_VERSION,
  REPOSITORY_INTELLIGENCE_SCHEMA_VERSION,
} from "./types.js";
import { deterministicIntelligenceVersion } from "./version.js";

function cycles(graph: ReadonlyMap<string, readonly string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) if (visit(next)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...graph.keys()].some(visit);
}

export function validateRepositoryIntelligence(
  snapshot: RepositoryIntelligenceSnapshot,
  previousIntelligenceVersion: string | null = null,
  validatedAt = new Date().toISOString(),
): RepositoryIntelligenceValidation {
  const diagnostics: RepositoryIntelligenceDiagnostic[] = [];
  const add = (code: string, message: string, path?: string) =>
    diagnostics.push({ code, message, ...(path ? { path } : {}) });
  if (!snapshot.repositoryRevision.trim()) add("missing_repository_revision", "Repository revision is required.");
  if (!snapshot.graphVersion.trim()) add("missing_graph_version", "Graph version is required.");
  if (!snapshot.embeddingVersion.trim()) add("missing_embedding_version", "Embedding version is required.");
  if (snapshot.analysisVersion !== REPOSITORY_INTELLIGENCE_ANALYSIS_VERSION ||
      snapshot.schemaVersion !== REPOSITORY_INTELLIGENCE_SCHEMA_VERSION) {
    add("version_incompatible", "Intelligence analysis or schema version is incompatible.");
  }
  const expectedVersion = deterministicIntelligenceVersion(snapshot);
  if (snapshot.intelligenceVersion !== expectedVersion) {
    add("intelligence_version_mismatch", "Intelligence version does not match its deterministic identity.");
  }
  const subsystemIds = snapshot.subsystems.map((item) => item.subsystemId);
  if (new Set(subsystemIds).size !== subsystemIds.length) {
    add("duplicate_subsystem_id", "Subsystem IDs must be unique.");
  }
  const known = new Set(subsystemIds);
  for (const subsystem of snapshot.subsystems) {
    for (const dependency of subsystem.dependencies) {
      if (!known.has(dependency)) {
        add("orphan_subsystem_reference", "Subsystem dependency does not exist.", dependency);
      }
    }
  }
  for (const edge of snapshot.architecture.dependencyGraph) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to || edge.count < 1) {
      add("invalid_dependency_graph", "Subsystem dependency graph is inconsistent.");
      break;
    }
  }
  if (snapshot.metrics.generatedSubsystems !== snapshot.subsystems.length ||
      snapshot.metrics.dependencyEdgesAnalyzed < snapshot.architecture.dependencyGraph.length ||
      snapshot.metrics.filesAnalyzed < 0 || snapshot.metrics.symbolsAnalyzed < 0) {
    add("metric_inconsistency", "Intelligence metrics do not match snapshot content.");
  }
  if (previousIntelligenceVersion === snapshot.intelligenceVersion) {
    add("cyclic_publication_metadata", "Publication metadata cannot point to itself.");
  }
  return { valid: diagnostics.length === 0, diagnostics, validatedAt };
}

export function validatePublicationIntegrity(records: readonly RepositoryIntelligenceRecord[]): void {
  const published = records.filter((record) => record.status === "published");
  const byRepository = new Map<string, number>();
  for (const record of published) {
    byRepository.set(record.repositoryId, (byRepository.get(record.repositoryId) ?? 0) + 1);
    const graph = new Map<string, string[]>();
    if (record.publicationMetadata.previousIntelligenceVersion) {
      graph.set(record.intelligenceVersion, [record.publicationMetadata.previousIntelligenceVersion]);
    }
    if (cycles(graph)) throw new Error("Repository intelligence publication metadata is cyclic.");
  }
  if ([...byRepository.values()].some((count) => count > 1)) {
    throw new Error("Repository intelligence has multiple current publications.");
  }
}
