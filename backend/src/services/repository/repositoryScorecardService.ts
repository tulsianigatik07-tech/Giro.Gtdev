import type { RepositoryComparisonReport } from "./repositoryComparisonEngine.js";
import type { RepositoryHotspotReport } from "./repositoryHotspotAnalyzer.js";
import type { RepositoryIntelligenceReport } from "./repositoryIntelligenceReport.js";
import type {
  RepositoryRecommendation,
  RepositoryRecommendationPriority,
  RepositoryRecommendationResult,
} from "./repositoryRecommendationEngine.js";
import type { RepositoryRiskReport } from "./repositoryRiskAnalyzer.js";
import type { DeepReadonly } from "./repositorySnapshotStore.js";

export type RepositoryScorecardVerdict =
  | "EXCELLENT"
  | "GOOD"
  | "NEEDS_ATTENTION"
  | "BLOCKED";

export interface RepositoryScorecardSection {
  score: number;
  status: string;
  summary: string;
}

export interface RepositoryScorecardSections {
  health: RepositoryScorecardSection;
  readiness: RepositoryScorecardSection;
  architecture: RepositoryScorecardSection;
  risk: RepositoryScorecardSection;
  momentum: RepositoryScorecardSection;
}

export interface RepositoryScorecard {
  repositoryId: string;
  overallScore: number;
  verdict: RepositoryScorecardVerdict;
  badges: readonly string[];
  strengths: readonly string[];
  weaknesses: readonly string[];
  blockers: readonly string[];
  topActions: readonly string[];
  sections: RepositoryScorecardSections;
  summary: string;
}

export interface RepositoryScorecardInput {
  report: RepositoryIntelligenceReport;
  risk: RepositoryRiskReport;
  hotspots: RepositoryHotspotReport;
  recommendations: RepositoryRecommendationResult;
  comparison?: RepositoryComparisonReport;
}

const PRIORITY_ORDER: Record<RepositoryRecommendationPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (typeof value !== "object" || value === null) {
    return value as DeepReadonly<T>;
  }

  if (seen.has(value)) {
    return value as DeepReadonly<T>;
  }

  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    deepFreeze(child, seen);
  }

  return Object.freeze(value) as DeepReadonly<T>;
}

function readinessScore(level: RepositoryIntelligenceReport["aiReadiness"]["level"]): number {
  if (level === "ready") return 100;
  if (level === "degraded") return 60;
  return 15;
}

function momentumScore(comparison: RepositoryComparisonReport | undefined): number {
  if (!comparison) return 50;
  if (comparison.trend === "IMPROVING") return 80;
  if (comparison.trend === "REGRESSING") return 25;
  return 50;
}

function overallScore(input: RepositoryScorecardInput): number {
  const health = input.report.health.score;
  const readiness = readinessScore(input.report.aiReadiness.level);
  const risk = 100 - input.risk.score;
  const momentum = momentumScore(input.comparison);

  return clampScore(health * 0.45 + readiness * 0.25 + risk * 0.2 + momentum * 0.1);
}

function blockersFor(input: RepositoryScorecardInput): string[] {
  return sortedUnique([
    ...input.report.aiReadiness.blockers,
    ...input.risk.blockers,
  ]);
}

function hasCriticalBlocker(
  input: RepositoryScorecardInput,
  blockers: readonly string[],
): boolean {
  return (
    blockers.length > 0 ||
    input.report.aiReadiness.level === "blocked" ||
    input.risk.level === "CRITICAL" ||
    input.hotspots.summary.critical > 0 ||
    input.recommendations.summary.critical > 0
  );
}

function verdictFor(
  input: RepositoryScorecardInput,
  score: number,
  blockers: readonly string[],
): RepositoryScorecardVerdict {
  if (hasCriticalBlocker(input, blockers)) return "BLOCKED";
  if (
    input.report.aiReadiness.level === "degraded" ||
    input.risk.level === "HIGH" ||
    score < 70
  ) {
    return "NEEDS_ATTENTION";
  }
  if (score >= 90 && input.risk.level === "LOW") return "EXCELLENT";
  return "GOOD";
}

function badgesFor(
  input: RepositoryScorecardInput,
  verdict: RepositoryScorecardVerdict,
): string[] {
  const badges: string[] = [verdict];

  if (input.report.health.healthy) badges.push("HEALTHY");
  if (input.report.aiReadiness.ready) badges.push("AI_READY");
  if (input.risk.level === "LOW") badges.push("LOW_RISK");
  if (input.risk.level === "HIGH" || input.risk.level === "CRITICAL") {
    badges.push("RISK_ELEVATED");
  }
  if (input.hotspots.hotspots.length === 0) badges.push("NO_HOTSPOTS");
  if (input.comparison?.trend === "IMPROVING") badges.push("MOMENTUM_UP");
  if (input.comparison?.trend === "REGRESSING") badges.push("MOMENTUM_DOWN");

  return sortedUnique(badges);
}

function strengthsFor(input: RepositoryScorecardInput): string[] {
  const strengths: string[] = [
    ...input.report.summary.strengths,
    ...input.risk.strengths,
  ];

  if (input.report.health.healthy) strengths.push("Health score is in a healthy range.");
  if (input.report.aiReadiness.ready) strengths.push("Repository is ready for AI workflows.");
  if (input.hotspots.hotspots.length === 0) strengths.push("No architecture hotspots are active.");
  if (input.comparison?.trend === "IMPROVING") strengths.push("Repository momentum is improving.");

  return sortedUnique(strengths);
}

function weaknessesFor(input: RepositoryScorecardInput): string[] {
  const weaknesses: string[] = [
    ...input.report.summary.risks,
    ...input.report.health.warnings,
    ...input.report.aiReadiness.warnings,
    ...input.risk.risks,
  ];

  for (const hotspot of input.hotspots.hotspots) {
    weaknesses.push(hotspot.title);
  }

  if (input.comparison?.trend === "REGRESSING") {
    weaknesses.push("Repository momentum is regressing.");
  }

  return sortedUnique(weaknesses);
}

function sortedRecommendations(
  recommendations: readonly RepositoryRecommendation[],
): RepositoryRecommendation[] {
  return [...recommendations].sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      a.id.localeCompare(b.id),
  );
}

function topActionsFor(input: RepositoryScorecardInput): string[] {
  const actions = sortedRecommendations(input.recommendations.recommendations)
    .filter((recommendation) => recommendation.id !== "repository.healthy")
    .map((recommendation) => recommendation.action);

  return uniqueInOrder(actions).slice(0, 5);
}

function section(
  score: number,
  status: string,
  summary: string,
): RepositoryScorecardSection {
  return {
    score: clampScore(score),
    status,
    summary,
  };
}

function architectureScore(hotspots: RepositoryHotspotReport): number {
  return clampScore(
    100 -
      hotspots.summary.critical * 30 -
      hotspots.summary.high * 18 -
      hotspots.summary.medium * 10 -
      hotspots.summary.low * 4,
  );
}

function sectionsFor(input: RepositoryScorecardInput): RepositoryScorecardSections {
  const momentum = momentumScore(input.comparison);
  const architecture = architectureScore(input.hotspots);

  return {
    health: section(
      input.report.health.score,
      input.report.health.grade,
      input.report.health.healthy
        ? "Health signals are in range."
        : "Health signals need attention.",
    ),
    readiness: section(
      input.report.aiReadiness.score,
      input.report.aiReadiness.level,
      input.report.aiReadiness.ready
        ? "Repository is ready for AI workflows."
        : "AI readiness is limited by blockers or warnings.",
    ),
    architecture: section(
      architecture,
      input.hotspots.hotspots.length === 0 ? "clear" : "hotspots",
      `${input.hotspots.hotspots.length} hotspot(s) active.`,
    ),
    risk: section(
      100 - input.risk.score,
      input.risk.level,
      input.risk.summary,
    ),
    momentum: section(
      momentum,
      input.comparison?.trend ?? "STABLE",
      momentum === 80
        ? "Recent comparison is improving."
        : momentum === 25
          ? "Recent comparison is regressing."
          : "Recent comparison is stable or unavailable.",
    ),
  };
}

function summaryFor(verdict: RepositoryScorecardVerdict, score: number): string {
  if (verdict === "EXCELLENT") {
    return `Repository scorecard is excellent (${score}/100).`;
  }
  if (verdict === "GOOD") {
    return `Repository scorecard is good (${score}/100).`;
  }
  if (verdict === "BLOCKED") {
    return `Repository scorecard is blocked (${score}/100).`;
  }
  return `Repository scorecard needs attention (${score}/100).`;
}

export function buildRepositoryScorecard(
  input: RepositoryScorecardInput,
): DeepReadonly<RepositoryScorecard> {
  const blockers = blockersFor(input);
  const score = overallScore(input);
  const verdict = verdictFor(input, score, blockers);

  return deepFreeze({
    repositoryId: input.report.repositoryId,
    overallScore: score,
    verdict,
    badges: badgesFor(input, verdict),
    strengths: strengthsFor(input),
    weaknesses: weaknessesFor(input),
    blockers,
    topActions: topActionsFor(input),
    sections: sectionsFor(input),
    summary: summaryFor(verdict, score),
  });
}
