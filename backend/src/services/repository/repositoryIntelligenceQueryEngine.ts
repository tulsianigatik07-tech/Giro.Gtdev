import type { RepositoryArchitectureAnalysis } from "./repositoryArchitectureAnalyzer.js";
import type {
  RepositoryAiReadinessLevel,
  RepositoryAiReadinessResult,
} from "./repositoryAiReadinessEngine.js";
import type { RepositoryHealthEngineResult } from "./repositoryHealthEngine.js";
import type { RepositoryHotspotReport } from "./repositoryHotspotAnalyzer.js";
import type {
  RepositoryInsightSeverity,
  RepositoryInsightsEngineResult,
} from "./repositoryInsightsEngine.js";
import type { RepositoryRecommendationResult } from "./repositoryRecommendationEngine.js";
import type { RepositoryRiskLevel, RepositoryRiskReport } from "./repositoryRiskAnalyzer.js";

export type RepositoryIntelligenceQueryCategory =
  | "health"
  | "aiReadiness"
  | "risk"
  | "hotspots"
  | "recommendations"
  | "insights"
  | "architecture";

export type RepositoryIntelligenceQuerySeverity =
  | RepositoryInsightSeverity
  | "high"
  | "medium"
  | "low";

export interface RepositoryIntelligenceQueryReport {
  repositoryId?: string;
  health?: RepositoryHealthEngineResult;
  aiReadiness?: RepositoryAiReadinessResult;
  risk?: RepositoryRiskReport;
  hotspots?: RepositoryHotspotReport;
  recommendations?: RepositoryRecommendationResult;
  insights?: RepositoryInsightsEngineResult;
  architecture?: RepositoryArchitectureAnalysis;
}

export interface RepositoryIntelligenceQueryFilters {
  severity?: string | readonly string[];
  category?: string | readonly string[];
  module?: string | readonly string[];
  hotspot?: string | readonly string[];
  risk?: RepositoryRiskLevel | readonly RepositoryRiskLevel[];
  readiness?: RepositoryAiReadinessLevel | readonly RepositoryAiReadinessLevel[];
  health?: string | readonly string[];
  blocker?: string | readonly string[];
  recommendation?: string | readonly string[];
}

export interface RepositoryIntelligenceMatch {
  id: string;
  category: RepositoryIntelligenceQueryCategory;
  severity: string;
  title: string;
  description: string;
  modules: string[];
  keywords: string[];
}

export interface RepositoryIntelligenceQueryResult {
  repositoryId: string;
  matches: RepositoryIntelligenceMatch[];
  totalMatches: number;
  groupedResults: Record<RepositoryIntelligenceQueryCategory, RepositoryIntelligenceMatch[]>;
  summary: string;
}

const CATEGORY_ORDER: RepositoryIntelligenceQueryCategory[] = [
  "health",
  "aiReadiness",
  "risk",
  "hotspots",
  "recommendations",
  "insights",
  "architecture",
];

function normalizeFilter(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function includesAny(values: readonly string[], filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  const normalized = values.map((value) => value.toLowerCase());
  return filters.some((filter) =>
    normalized.some((value) => value.includes(filter)),
  );
}

function textIncludesAny(match: RepositoryIntelligenceMatch, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  const haystack = [
    match.id,
    match.category,
    match.severity,
    match.title,
    match.description,
    ...match.modules,
    ...match.keywords,
  ]
    .join(" ")
    .toLowerCase();
  return filters.some((filter) => haystack.includes(filter));
}

function copyMatch(match: RepositoryIntelligenceMatch): RepositoryIntelligenceMatch {
  return {
    id: match.id,
    category: match.category,
    severity: match.severity,
    title: match.title,
    description: match.description,
    modules: [...match.modules],
    keywords: [...match.keywords],
  };
}

function sortMatches(matches: readonly RepositoryIntelligenceMatch[]): RepositoryIntelligenceMatch[] {
  return [...matches].sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      a.id.localeCompare(b.id),
  );
}

function addMatch(
  matches: RepositoryIntelligenceMatch[],
  match: RepositoryIntelligenceMatch,
): void {
  matches.push({
    ...match,
    modules: sortedUnique(match.modules),
    keywords: sortedUnique(match.keywords),
  });
}

function repositoryIdFor(report: RepositoryIntelligenceQueryReport): string {
  return (
    report.repositoryId ??
    report.health?.repositoryId ??
    report.aiReadiness?.repositoryId ??
    report.risk?.repositoryId ??
    report.hotspots?.repositoryId ??
    report.recommendations?.repositoryId ??
    report.insights?.repositoryId ??
    "unknown"
  );
}

function collectMatches(report: RepositoryIntelligenceQueryReport): RepositoryIntelligenceMatch[] {
  const matches: RepositoryIntelligenceMatch[] = [];

  if (report.health) {
    addMatch(matches, {
      id: "health.status",
      category: "health",
      severity: report.health.healthy ? "success" : report.health.score < 40 ? "critical" : "warning",
      title: "Repository health",
      description: `Health score ${report.health.score} with ${report.health.grade} grade.`,
      modules: [],
      keywords: [
        report.health.grade,
        report.health.healthy ? "healthy" : "unhealthy",
        ...(report.health.signals.stale ? ["stale"] : []),
        ...(report.health.warnings ?? []),
      ],
    });
  }

  if (report.aiReadiness) {
    addMatch(matches, {
      id: "aiReadiness.status",
      category: "aiReadiness",
      severity: report.aiReadiness.level === "blocked" ? "critical" : report.aiReadiness.level === "degraded" ? "warning" : "success",
      title: "AI readiness",
      description: `AI readiness is ${report.aiReadiness.level} with score ${report.aiReadiness.score}.`,
      modules: [],
      keywords: [
        report.aiReadiness.level,
        ...report.aiReadiness.blockers,
        ...report.aiReadiness.warnings,
        ...report.aiReadiness.recommendations,
      ],
    });
  }

  if (report.risk) {
    addMatch(matches, {
      id: "risk.status",
      category: "risk",
      severity: report.risk.level === "CRITICAL" ? "critical" : report.risk.level === "HIGH" ? "high" : report.risk.level === "MEDIUM" ? "medium" : "low",
      title: "Repository risk",
      description: report.risk.summary,
      modules: [],
      keywords: [
        report.risk.level,
        ...report.risk.risks,
        ...report.risk.blockers,
        ...report.risk.strengths,
      ],
    });
  }

  for (const hotspot of report.hotspots?.hotspots ?? []) {
    addMatch(matches, {
      id: `hotspot.${hotspot.id}`,
      category: "hotspots",
      severity: hotspot.severity,
      title: hotspot.title,
      description: hotspot.description,
      modules: hotspot.affectedModules,
      keywords: [hotspot.id, hotspot.type, hotspot.reason],
    });
  }

  for (const recommendation of report.recommendations?.recommendations ?? []) {
    addMatch(matches, {
      id: `recommendation.${recommendation.id}`,
      category: "recommendations",
      severity: recommendation.severity,
      title: recommendation.title,
      description: recommendation.description,
      modules: [],
      keywords: [
        recommendation.category,
        recommendation.priority,
        recommendation.reason,
        recommendation.action,
      ],
    });
  }

  for (const insight of report.insights?.insights ?? []) {
    const moduleSignal = typeof insight.signals.module === "string" ? insight.signals.module : "";
    addMatch(matches, {
      id: `insight.${insight.id}`,
      category: "insights",
      severity: insight.severity,
      title: insight.title,
      description: insight.description,
      modules: moduleSignal ? [moduleSignal] : [],
      keywords: [insight.id, insight.type, insight.recommendation ?? ""],
    });
  }

  if (report.architecture) {
    addMatch(matches, {
      id: "architecture.summary",
      category: "architecture",
      severity:
        report.architecture.hasCycles || report.architecture.architectureComplexityScore >= 70
          ? "warning"
          : "info",
      title: "Architecture summary",
      description: `Architecture has ${report.architecture.totalFiles} files, ${report.architecture.totalDependencies} dependencies, and complexity score ${report.architecture.architectureComplexityScore}.`,
      modules: [
        ...report.architecture.rootModules,
        ...report.architecture.leafModules,
        ...report.architecture.isolatedModules,
        ...report.architecture.mostConnectedModules.map((module) => module.filePath),
      ],
      keywords: [
        "architecture",
        ...(report.architecture.hasCycles ? ["cycle", "circular"] : []),
        ...(report.architecture.isolatedModules.length > 0 ? ["isolated"] : []),
      ],
    });
  }

  return sortMatches(matches);
}

function matchesFilters(
  match: RepositoryIntelligenceMatch,
  filters: RepositoryIntelligenceQueryFilters,
): boolean {
  const severity = normalizeFilter(filters.severity);
  const category = normalizeFilter(filters.category);
  const module = normalizeFilter(filters.module);
  const hotspot = normalizeFilter(filters.hotspot);
  const risk = normalizeFilter(filters.risk);
  const readiness = normalizeFilter(filters.readiness);
  const health = normalizeFilter(filters.health);
  const blocker = normalizeFilter(filters.blocker);
  const recommendation = normalizeFilter(filters.recommendation);

  return (
    includesAny([match.severity], severity) &&
    includesAny([match.category], category) &&
    includesAny(match.modules, module) &&
    (hotspot.length === 0 || (match.category === "hotspots" && textIncludesAny(match, hotspot))) &&
    (risk.length === 0 || (match.category === "risk" && textIncludesAny(match, risk))) &&
    (readiness.length === 0 || (match.category === "aiReadiness" && textIncludesAny(match, readiness))) &&
    (health.length === 0 || (match.category === "health" && textIncludesAny(match, health))) &&
    (blocker.length === 0 || textIncludesAny(match, blocker)) &&
    (recommendation.length === 0 || textIncludesAny(match, recommendation))
  );
}

function emptyGroups(): Record<RepositoryIntelligenceQueryCategory, RepositoryIntelligenceMatch[]> {
  return {
    health: [],
    aiReadiness: [],
    risk: [],
    hotspots: [],
    recommendations: [],
    insights: [],
    architecture: [],
  };
}

function groupMatches(
  matches: readonly RepositoryIntelligenceMatch[],
): Record<RepositoryIntelligenceQueryCategory, RepositoryIntelligenceMatch[]> {
  const grouped = emptyGroups();
  for (const match of matches) {
    grouped[match.category].push(copyMatch(match));
  }
  return grouped;
}

export function queryRepositoryIntelligence(input: {
  report: RepositoryIntelligenceQueryReport;
  filters?: RepositoryIntelligenceQueryFilters;
}): RepositoryIntelligenceQueryResult {
  const filters = input.filters ?? {};
  const matches = collectMatches(input.report)
    .filter((match) => matchesFilters(match, filters))
    .map(copyMatch);

  return {
    repositoryId: repositoryIdFor(input.report),
    matches,
    totalMatches: matches.length,
    groupedResults: groupMatches(matches),
    summary: `${matches.length} repository intelligence result(s) matched.`,
  };
}
