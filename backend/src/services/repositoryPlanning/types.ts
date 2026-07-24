import type { IntelligenceHistoryRecord, LifecycleHistoryRecord } from "../repository/history/repositoryHistoryStore.js";
import type { RepositoryIntelligenceRecord, RepositoryIntelligenceSnapshot } from "../repositoryIntelligence/types.js";
import type { RepositorySymbolGraph } from "../repositoryGraph/graphTypes.js";
import type { RetrievalResult } from "../retrieval/types.js";

export const REPOSITORY_PLANNER_VERSION = "repository-planner-v1";
export const REPOSITORY_PLAN_SCHEMA_VERSION = "repository-plan-schema-v1";

export type RepositoryPlanStatus =
  | "building"
  | "validating"
  | "published"
  | "failed"
  | "superseded";

export type PlanningDependencyKind =
  | "imports"
  | "calls"
  | "inherits"
  | "implements"
  | "subsystem";

export interface PlanDependency {
  dependencyId: string;
  fromFile: string;
  toFile: string;
  kind: PlanningDependencyKind;
  blocking: boolean;
}

export interface ImplementationPhase {
  phaseId: string;
  order: number;
  name: string;
  kind: "migration" | "implementation" | "integration" | "validation";
  subsystemIds: string[];
  files: string[];
  symbols: string[];
  dependsOn: string[];
  operations: string[];
  independentlyExecutable: boolean;
}

export interface PlanRiskAnalysis {
  architecturalRisk: number;
  dependencyRisk: number;
  blastRadius: number;
  publicApiImpact: number;
  migrationImpact: number;
  testingComplexity: number;
  overallRisk: number;
  level: "low" | "medium" | "high" | "critical";
}

export interface RepositoryExecutionPlan {
  planVersion: string;
  taskHash: string;
  repositoryId: string;
  repositoryRevision: string;
  intelligenceVersion: string;
  graphVersion: string;
  embeddingVersion: string;
  plannerVersion: string;
  schemaVersion: string;
  objective: string;
  assumptions: string[];
  affectedSubsystems: string[];
  affectedFiles: Array<{
    path: string;
    reasons: string[];
    retrievalScore: number | null;
  }>;
  affectedSymbols: Array<{
    nodeId: string;
    qualifiedName: string;
    file: string;
    kind: string;
    publicApi: boolean;
  }>;
  dependencyOrder: {
    dependencies: PlanDependency[];
    orderedFiles: string[];
    independentWork: string[][];
    blockingDependencies: string[];
    circularPlans: string[][];
  };
  implementationPhases: ImplementationPhase[];
  validationSteps: Array<{
    validationId: string;
    kind: "static" | "test" | "migration" | "contract" | "integration";
    command: string;
    required: boolean;
  }>;
  testingStrategy: {
    unit: string[];
    integration: string[];
    regression: string[];
  };
  migrationRequirements: {
    required: boolean;
    reasons: string[];
    affectedFiles: string[];
    reversible: boolean;
  };
  rollbackStrategy: {
    phaseOrder: string[];
    preserveData: boolean;
    actions: string[];
  };
  riskAnalysis: PlanRiskAnalysis;
  confidenceScore: number;
  retrievalContribution: {
    used: boolean;
    candidateCount: number;
    affectedFileCount: number;
    maximumScore: number;
  };
  inputStatistics: {
    repositoryFiles: number;
    repositorySymbols: number;
    dependencyEdges: number;
    historyRecords: number;
  };
}

export interface RepositoryPlanRecord extends RepositoryExecutionPlan {
  status: RepositoryPlanStatus;
  createdAt: string;
  validatedAt: string | null;
  publishedAt: string | null;
  publicationMetadata: {
    previousPlanVersion: string | null;
    repositoryRevision: string;
    intelligenceVersion: string;
    graphVersion: string;
    embeddingVersion: string;
  };
}

export interface RepositoryPlanDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface RepositoryPlanValidation {
  valid: boolean;
  diagnostics: RepositoryPlanDiagnostic[];
  validatedAt: string;
}

export interface RepositoryStatisticsInput {
  files: number;
  symbols: number;
  dependencyEdges: number;
  [key: string]: number;
}

export interface RepositoryPlanningInput {
  repositoryId: string;
  repositoryRevision: string;
  userTask: string;
  intelligence: RepositoryIntelligenceRecord | RepositoryIntelligenceSnapshot;
  graph: RepositorySymbolGraph;
  embeddingVersion: string;
  retrievalResults: readonly RetrievalResult[];
  repositoryStatistics: RepositoryStatisticsInput;
  repositoryHistory: readonly (LifecycleHistoryRecord | IntelligenceHistoryRecord)[];
}

export interface RepositoryPlanIdentity {
  planVersion: string;
  taskHash: string;
  repositoryId: string;
  repositoryRevision: string;
  intelligenceVersion: string;
  graphVersion: string;
  embeddingVersion: string;
  plannerVersion: string;
  schemaVersion: string;
}

export interface RepositoryPlanValidationContext {
  knownFiles: string[];
  knownNodeIds: string[];
}
