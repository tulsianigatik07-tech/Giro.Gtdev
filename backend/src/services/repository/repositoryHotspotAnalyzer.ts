import type { RepositoryArchitectureAnalysis } from "./repositoryArchitectureAnalyzer.js";
import type { RepositoryDependencyEdge } from "./repositoryDependencyGraph.js";
import type { RepositoryHealthEngineResult } from "./repositoryHealthEngine.js";
import type {
  RepositoryInsight,
  RepositoryInsightsEngineResult,
} from "./repositoryInsightsEngine.js";

export interface RepositoryHotspotGraph {
  listNodes(): string[];
  listEdges(): RepositoryDependencyEdge[];
  getDependencies(filePath: string): string[];
  getDependents(filePath: string): string[];
  hasCycle(): boolean;
}

export type RepositoryHotspotType =
  | "dependency_hub"
  | "cycle_cluster"
  | "isolated_module"
  | "unhealthy_region"
  | "high_complexity"
  | "stale_area"
  | "indexing_bottleneck"
  | "critical_chain";

export type RepositoryHotspotSeverity = "critical" | "high" | "medium" | "low";

export interface RepositoryHotspot {
  id: string;
  type: RepositoryHotspotType;
  severity: RepositoryHotspotSeverity;
  title: string;
  description: string;
  affectedModules: string[];
  reason: string;
}

export interface RepositoryHotspotSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface RepositoryHotspotAnalyzerInput {
  graph: RepositoryHotspotGraph;
  architecture: RepositoryArchitectureAnalysis;
  health: RepositoryHealthEngineResult;
  insights: RepositoryInsightsEngineResult;
}

export interface RepositoryHotspotReport {
  repositoryId: string;
  hotspots: RepositoryHotspot[];
  summary: RepositoryHotspotSummary;
}

const SEVERITY_ORDER: RepositoryHotspotSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
];

function severityRank(severity: RepositoryHotspotSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function addHotspot(hotspots: RepositoryHotspot[], hotspot: RepositoryHotspot): void {
  if (hotspots.some((item) => item.id === hotspot.id)) return;

  hotspots.push({
    ...hotspot,
    affectedModules: sortedUnique(hotspot.affectedModules),
  });
}

function summarize(hotspots: readonly RepositoryHotspot[]): RepositoryHotspotSummary {
  return {
    critical: hotspots.filter((hotspot) => hotspot.severity === "critical").length,
    high: hotspots.filter((hotspot) => hotspot.severity === "high").length,
    medium: hotspots.filter((hotspot) => hotspot.severity === "medium").length,
    low: hotspots.filter((hotspot) => hotspot.severity === "low").length,
  };
}

function sortHotspots(hotspots: readonly RepositoryHotspot[]): RepositoryHotspot[] {
  return [...hotspots].sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.type.localeCompare(b.type) ||
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

function dependencyChainModules(graph: RepositoryHotspotGraph): string[] {
  const nodes = sortedUnique(graph.listNodes());

  return nodes.filter((filePath) => {
    const dependencyCount = graph.getDependencies(filePath).length;
    const dependentCount = graph.getDependents(filePath).length;
    return dependencyCount > 0 && dependentCount > 0;
  });
}

function repositoryIdFor(input: RepositoryHotspotAnalyzerInput): string {
  if (input.health.repositoryId !== "unknown") return input.health.repositoryId;
  if (input.insights.repositoryId !== "unknown") return input.insights.repositoryId;
  return "unknown";
}

export function analyzeRepositoryHotspots(
  input: RepositoryHotspotAnalyzerInput,
): RepositoryHotspotReport {
  const { graph, architecture, health, insights } = input;
  const hotspots: RepositoryHotspot[] = [];
  const graphHasCycle = graph.hasCycle();

  const hubs = architecture.mostConnectedModules.filter(
    (module) => module.totalConnections >= 4,
  );
  if (hubs.length > 0) {
    addHotspot(hotspots, {
      id: "architecture.dependency-hubs",
      type: "dependency_hub",
      severity: "high",
      title: "Central dependency hubs",
      description: "Some modules concentrate a high number of dependency relationships.",
      affectedModules: hubs.map((module) => module.filePath),
      reason: `${hubs.length} module(s) have at least 4 dependency connections.`,
    });
  }

  if (architecture.hasCycles || graphHasCycle || architecture.circularDependencyCount > 0) {
    addHotspot(hotspots, {
      id: "architecture.circular-clusters",
      type: "cycle_cluster",
      severity: "critical",
      title: "Circular dependency clusters",
      description: "Circular dependencies create tightly coupled architectural regions.",
      affectedModules: architecture.mostConnectedModules
        .filter((module) => module.totalConnections > 0)
        .map((module) => module.filePath),
      reason: `${architecture.circularDependencyCount} circular dependency cluster(s) were detected.`,
    });
  }

  if (architecture.isolatedModules.length > 0) {
    addHotspot(hotspots, {
      id: "architecture.isolated-modules",
      type: "isolated_module",
      severity: "medium",
      title: "Isolated modules",
      description: "Some modules have no incoming or outgoing dependency relationships.",
      affectedModules: architecture.isolatedModules,
      reason: `${architecture.isolatedModules.length} isolated module(s) were detected.`,
    });
  }

  if (!health.healthy) {
    addHotspot(hotspots, {
      id: "health.unhealthy-architecture",
      type: "unhealthy_region",
      severity: health.score < 40 ? "critical" : "high",
      title: "Unhealthy architectural region",
      description: "Repository health signals indicate architecture needs attention.",
      affectedModules: architecture.mostConnectedModules
        .slice(0, 5)
        .map((module) => module.filePath),
      reason:
        health.warnings.join(" ") ||
        `Repository health score is ${health.score} with ${health.grade} grade.`,
    });
  }

  if (architecture.architectureComplexityScore >= 70) {
    addHotspot(hotspots, {
      id: "architecture.high-complexity",
      type: "high_complexity",
      severity: "high",
      title: "High complexity modules",
      description: "Architecture complexity is elevated around the most connected modules.",
      affectedModules: architecture.mostConnectedModules
        .slice(0, 5)
        .map((module) => module.filePath),
      reason: `Architecture complexity score is ${architecture.architectureComplexityScore}.`,
    });
  }

  if (health.signals.stale) {
    addHotspot(hotspots, {
      id: "analysis.stale-architecture",
      type: "stale_area",
      severity: "medium",
      title: "Stale architectural areas",
      description: "Architecture data may not reflect the latest repository state.",
      affectedModules: [],
      reason: "Repository health signals report stale index metadata.",
    });
  }

  if (!health.signals.indexed || !health.signals.ready) {
    addHotspot(hotspots, {
      id: "analysis.indexing-bottleneck",
      type: "indexing_bottleneck",
      severity: "critical",
      title: "Indexing bottleneck",
      description: "Architecture hotspots may be incomplete while indexing is blocked.",
      affectedModules: [],
      reason: "Repository health signals report indexing or readiness blockers.",
    });
  }

  const chainModules = dependencyChainModules(graph);
  if (
    chainModules.length >= 3 ||
    (architecture.totalDependencies >= 4 && architecture.averageDependencies >= 1)
  ) {
    addHotspot(hotspots, {
      id: "architecture.critical-dependency-chains",
      type: "critical_chain",
      severity: "high",
      title: "Critical dependency chains",
      description: "Several modules sit between incoming and outgoing dependencies.",
      affectedModules: chainModules,
      reason: `${chainModules.length} module(s) participate in dependency chains.`,
    });
  }

  for (const insight of architectureInsights(insights)) {
    addHotspot(hotspots, {
      id: `insight.${insight.id}`,
      type: insight.severity === "critical" ? "unhealthy_region" : "high_complexity",
      severity: insight.severity === "critical" ? "critical" : "medium",
      title: insight.title,
      description: insight.description,
      affectedModules:
        typeof insight.signals.module === "string" ? [insight.signals.module] : [],
      reason: `Architecture insight ${insight.id} has ${insight.severity} severity.`,
    });
  }

  const sorted = sortHotspots(hotspots);

  return {
    repositoryId: repositoryIdFor(input),
    hotspots: sorted.map((hotspot) => ({
      ...hotspot,
      affectedModules: [...hotspot.affectedModules],
    })),
    summary: summarize(sorted),
  };
}
