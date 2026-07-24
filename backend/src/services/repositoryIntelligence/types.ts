import type { RepositoryGraphEdge, RepositoryGraphNode } from "../repositoryGraph/graphTypes.js";

export const REPOSITORY_INTELLIGENCE_ANALYSIS_VERSION = "repository-intelligence-v1";
export const REPOSITORY_INTELLIGENCE_SCHEMA_VERSION = "repository-intelligence-schema-v1";

export type RepositoryIntelligenceStatus =
  | "building"
  | "validating"
  | "published"
  | "failed"
  | "superseded";

export interface RankedModule {
  path: string;
  value: number;
}

export interface RepositorySubsystemSummary {
  subsystemId: string;
  name: string;
  rootPath: string;
  layer: string;
  files: string[];
  dependencies: string[];
  publicApis: string[];
  entrypoints: string[];
  summary: string;
  metrics: {
    files: number;
    symbols: number;
    incomingDependencies: number;
    outgoingDependencies: number;
  };
}

export interface RepositoryIntelligenceMetrics {
  filesAnalyzed: number;
  symbolsAnalyzed: number;
  dependencyEdgesAnalyzed: number;
  generatedSubsystems: number;
  qualityFindings: number;
  hotspots: number;
}

export interface RepositoryIntelligenceSnapshot {
  intelligenceVersion: string;
  repositoryId: string;
  repositoryRevision: string;
  graphVersion: string;
  embeddingVersion: string;
  parserVersion: string;
  analysisVersion: string;
  schemaVersion: string;
  architecture: {
    subsystemIds: string[];
    packageHierarchy: string[];
    dependencyGraph: Array<{ from: string; to: string; count: number }>;
    layers: Array<{ name: string; paths: string[] }>;
    hotspots: RankedModule[];
  };
  codeOrganization: {
    largestModules: RankedModule[];
    mostImportedFiles: RankedModule[];
    highestFanIn: RankedModule[];
    highestFanOut: RankedModule[];
    cyclicDependencies: string[][];
    utilityClusters: Array<{ name: string; files: string[] }>;
  };
  symbols: {
    publicApis: Array<Pick<RepositoryGraphNode, "name" | "qualifiedName" | "kind" | "file" | "line">>;
    internalApis: Array<Pick<RepositoryGraphNode, "name" | "qualifiedName" | "kind" | "file" | "line">>;
    orphanSymbols: string[];
    deadExports: string[];
    entrypoints: string[];
    sharedAbstractions: string[];
  };
  quality: {
    duplicateImplementations: Array<{ signature: string; symbols: string[] }>;
    oversizedFiles: RankedModule[];
    oversizedFunctions: RankedModule[];
    todoFixmeDensity: number;
    generatedCodeRatio: number;
    documentationCoverage: number;
  };
  evolution: {
    changedHotspots: RankedModule[];
    stableAreas: string[];
    architecturalDrift: Array<{ subsystemId: string; dependencyDelta: number }>;
    growth: {
      files: number;
      symbols: number;
      dependencyEdges: number;
      fileDelta: number;
      symbolDelta: number;
      dependencyEdgeDelta: number;
    };
  };
  subsystems: RepositorySubsystemSummary[];
  metrics: RepositoryIntelligenceMetrics;
}

export interface RepositoryIntelligenceRecord extends RepositoryIntelligenceSnapshot {
  status: RepositoryIntelligenceStatus;
  createdAt: string;
  validatedAt: string | null;
  publishedAt: string | null;
  publicationMetadata: {
    repositoryRevision: string;
    graphVersion: string;
    embeddingVersion: string;
    previousIntelligenceVersion: string | null;
  };
}

export interface RepositoryIntelligenceDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface RepositoryIntelligenceValidation {
  valid: boolean;
  diagnostics: RepositoryIntelligenceDiagnostic[];
  validatedAt: string;
}

export interface RepositoryIntelligenceBuildInput {
  repositoryId: string;
  repositoryRevision: string;
  graphVersion: string;
  embeddingVersion: string;
  parserVersion: string;
  nodes: readonly RepositoryGraphNode[];
  edges: readonly RepositoryGraphEdge[];
  files: ReadonlyArray<{ filePath: string; size: number; content?: string }>;
  previous?: RepositoryIntelligenceSnapshot | null;
  changedFiles?: readonly string[];
}

export interface RepositoryIntelligenceQuota {
  maxBytes: number;
  maxDurationMs: number;
}
