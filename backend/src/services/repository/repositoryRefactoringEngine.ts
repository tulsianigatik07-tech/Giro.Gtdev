import type { RepositoryArchitectureAnalysis } from "./repositoryArchitectureAnalyzer.js";
import type { RepositoryHealthEngineResult } from "./repositoryHealthEngine.js";
import type {
  RepositoryInsight,
  RepositoryInsightsEngineResult,
} from "./repositoryInsightsEngine.js";

export type RepositoryRefactoringSeverity = "critical" | "warning" | "info";
export type RepositoryRefactoringImpact = "high" | "medium" | "low";

export interface RepositoryRefactoringOpportunity {
  id: string;
  severity: RepositoryRefactoringSeverity;
  title: string;
  description: string;
  reason: string;
  recommendation: string;
  impactedModules: string[];
  estimatedImpact: RepositoryRefactoringImpact;
}

export interface RepositoryRefactoringSummary {
  total: number;
  critical: number;
  warnings: number;
  informational: number;
  impactedModuleCount: number;
}

export interface RepositoryRefactoringInput {
  architecture: RepositoryArchitectureAnalysis;
  health: RepositoryHealthEngineResult;
  insights: RepositoryInsightsEngineResult;
}

export interface RepositoryRefactoringReport {
  repositoryId: string;
  opportunities: RepositoryRefactoringOpportunity[];
  summary: RepositoryRefactoringSummary;
}

const SEVERITY_ORDER: RepositoryRefactoringSeverity[] = [
  "critical",
  "warning",
  "info",
];

function severityRank(severity: RepositoryRefactoringSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function addOpportunity(
  opportunities: RepositoryRefactoringOpportunity[],
  opportunity: RepositoryRefactoringOpportunity,
): void {
  if (!opportunities.some((item) => item.id === opportunity.id)) {
    opportunities.push({
      ...opportunity,
      impactedModules: sortedUnique(opportunity.impactedModules),
    });
  }
}

function summarize(
  opportunities: readonly RepositoryRefactoringOpportunity[],
): RepositoryRefactoringSummary {
  const impactedModules = opportunities.flatMap(
    (opportunity) => opportunity.impactedModules,
  );

  return {
    total: opportunities.length,
    critical: opportunities.filter((item) => item.severity === "critical").length,
    warnings: opportunities.filter((item) => item.severity === "warning").length,
    informational: opportunities.filter((item) => item.severity === "info").length,
    impactedModuleCount: sortedUnique(impactedModules).length,
  };
}

function sortOpportunities(
  opportunities: readonly RepositoryRefactoringOpportunity[],
): RepositoryRefactoringOpportunity[] {
  return [...opportunities].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.id.localeCompare(b.id),
  );
}

function architectureInsights(
  insights: RepositoryInsightsEngineResult,
): RepositoryInsight[] {
  return insights.insights
    .filter(
      (insight) =>
        insight.type === "architecture" &&
        (insight.severity === "critical" || insight.severity === "warning"),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function buildRepositoryRefactoringReport(
  input: RepositoryRefactoringInput,
): RepositoryRefactoringReport {
  const opportunities: RepositoryRefactoringOpportunity[] = [];
  const { architecture, health, insights } = input;
  const repositoryId =
    health.repositoryId !== "unknown" ? health.repositoryId : insights.repositoryId;

  if (!health.signals.indexed || !health.signals.ready) {
    addOpportunity(opportunities, {
      id: "analysis.indexing-blocked",
      severity: "critical",
      title: "Resolve indexing blockers before architecture analysis",
      description:
        "Repository architecture analysis may be incomplete because indexing is not available.",
      reason: "Repository health signals report that indexing or readiness is blocked.",
      recommendation: "Complete repository indexing before planning refactors.",
      impactedModules: [],
      estimatedImpact: "high",
    });
  }

  if (health.signals.stale) {
    addOpportunity(opportunities, {
      id: "analysis.stale-architecture",
      severity: "warning",
      title: "Refresh stale architecture data",
      description: "Architecture signals may not reflect the current repository state.",
      reason: "Repository health signals report stale index metadata.",
      recommendation: "Refresh or reindex the repository before acting on architecture findings.",
      impactedModules: [],
      estimatedImpact: "medium",
    });
  }

  if (!health.healthy) {
    addOpportunity(opportunities, {
      id: "architecture.unhealthy-repository",
      severity: health.score < 40 ? "critical" : "warning",
      title: "Improve repository architecture health",
      description: "Repository health is below the healthy operating threshold.",
      reason:
        health.warnings.join(" ") ||
        `Repository health score is ${health.score} with ${health.grade} grade.`,
      recommendation:
        health.recommendations[0] ?? "Review repository health warnings before refactoring.",
      impactedModules: [],
      estimatedImpact: health.score < 40 ? "high" : "medium",
    });
  }

  if (architecture.isolatedModules.length > 0) {
    addOpportunity(opportunities, {
      id: "architecture.isolated-modules",
      severity: "warning",
      title: "Review isolated modules",
      description: "Some modules have no incoming or outgoing dependency relationships.",
      reason: `${architecture.isolatedModules.length} isolated module(s) were detected.`,
      recommendation:
        "Confirm these modules are intentionally standalone or remove unused code.",
      impactedModules: architecture.isolatedModules,
      estimatedImpact: "medium",
    });
  }

  if (architecture.hasCycles || architecture.circularDependencyCount > 0) {
    addOpportunity(opportunities, {
      id: "architecture.circular-dependencies",
      severity: "critical",
      title: "Break circular dependencies",
      description: "Circular dependencies make module boundaries harder to reason about.",
      reason: `${architecture.circularDependencyCount} circular dependency group(s) were detected.`,
      recommendation:
        "Extract shared contracts or invert dependencies to remove circular module references.",
      impactedModules: architecture.mostConnectedModules
        .filter((module) => module.totalConnections > 0)
        .map((module) => module.filePath),
      estimatedImpact: "high",
    });
  }

  if (
    architecture.totalFiles > 0 &&
    (architecture.averageDependencies >= 3 || architecture.averageDependents >= 3)
  ) {
    addOpportunity(opportunities, {
      id: "architecture.excessive-coupling",
      severity: "warning",
      title: "Reduce excessive coupling",
      description: "The repository has a high average number of module relationships.",
      reason: `Average dependencies: ${architecture.averageDependencies}; average dependents: ${architecture.averageDependents}.`,
      recommendation:
        "Introduce clearer module boundaries and reduce cross-module imports.",
      impactedModules: architecture.mostConnectedModules
        .slice(0, 5)
        .map((module) => module.filePath),
      estimatedImpact: "high",
    });
  }

  const dependencyHubs = architecture.mostConnectedModules.filter(
    (module) => module.totalConnections >= 4,
  );
  if (dependencyHubs.length > 0) {
    addOpportunity(opportunities, {
      id: "architecture.dependency-hubs",
      severity: "warning",
      title: "Split oversized dependency hubs",
      description: "Some modules concentrate too many dependency relationships.",
      reason: `${dependencyHubs.length} oversized dependency hub(s) were detected.`,
      recommendation:
        "Split hub modules by responsibility or move shared concerns behind smaller interfaces.",
      impactedModules: dependencyHubs.map((module) => module.filePath),
      estimatedImpact: "high",
    });
  }

  if (architecture.architectureComplexityScore >= 70) {
    addOpportunity(opportunities, {
      id: "architecture.high-complexity",
      severity: "warning",
      title: "Lower architecture complexity",
      description: "Architecture complexity is high enough to warrant focused refactoring.",
      reason: `Architecture complexity score is ${architecture.architectureComplexityScore}.`,
      recommendation:
        "Prioritize the highest-connected modules and dependency cycles first.",
      impactedModules: architecture.mostConnectedModules
        .slice(0, 5)
        .map((module) => module.filePath),
      estimatedImpact: "high",
    });
  }

  for (const insight of architectureInsights(insights)) {
    addOpportunity(opportunities, {
      id: `insight.${insight.id}`,
      severity: insight.severity === "critical" ? "critical" : "warning",
      title: insight.title,
      description: insight.description,
      reason: `Architecture insight ${insight.id} has ${insight.severity} severity.`,
      recommendation: insight.recommendation ?? "Review the architecture insight.",
      impactedModules:
        typeof insight.signals.module === "string" ? [insight.signals.module] : [],
      estimatedImpact: insight.severity === "critical" ? "high" : "medium",
    });
  }

  const sorted = sortOpportunities(opportunities);

  return {
    repositoryId,
    opportunities: sorted.map((opportunity) => ({
      ...opportunity,
      impactedModules: [...opportunity.impactedModules],
    })),
    summary: summarize(sorted),
  };
}
