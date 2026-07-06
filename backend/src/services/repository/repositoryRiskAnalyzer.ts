import type { RepositoryArchitectureAnalysis } from "./repositoryArchitectureAnalyzer.js";
import type { RepositoryHealthEngineResult } from "./repositoryHealthEngine.js";
import type { RepositoryHotspotReport } from "./repositoryHotspotAnalyzer.js";
import type { RepositoryInsightsEngineResult } from "./repositoryInsightsEngine.js";

export type RepositoryRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RepositoryRiskSignals {
  healthy: boolean;
  indexed: boolean;
  ready: boolean;
  stale: boolean;
  healthScore: number;
  architectureComplexityScore: number;
  totalFiles: number;
  totalDependencies: number;
  circularDependencyCount: number;
  dependencyHubCount: number;
  criticalHotspots: number;
  highHotspots: number;
  mediumHotspots: number;
  lowHotspots: number;
  criticalInsights: number;
  warningInsights: number;
  failedIndexingSignals: number;
}

export interface RepositoryRiskInput {
  health: RepositoryHealthEngineResult;
  architecture: RepositoryArchitectureAnalysis;
  hotspots: RepositoryHotspotReport;
  insights: RepositoryInsightsEngineResult;
}

export interface RepositoryRiskReport {
  repositoryId: string;
  score: number;
  level: RepositoryRiskLevel;
  summary: string;
  strengths: string[];
  risks: string[];
  blockers: string[];
  signals: RepositoryRiskSignals;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function riskLevel(score: number): RepositoryRiskLevel {
  if (score >= 80) return "CRITICAL";
  if (score >= 55) return "HIGH";
  if (score >= 25) return "MEDIUM";
  return "LOW";
}

function repositoryIdFor(input: RepositoryRiskInput): string {
  if (input.health.repositoryId !== "unknown") return input.health.repositoryId;
  if (input.hotspots.repositoryId !== "unknown") return input.hotspots.repositoryId;
  if (input.insights.repositoryId !== "unknown") return input.insights.repositoryId;
  return "unknown";
}

function failedIndexingSignals(health: RepositoryHealthEngineResult): number {
  return health.warnings.filter((warning) =>
    warning.toLowerCase().includes("failed"),
  ).length;
}

function dependencyHubCount(input: RepositoryRiskInput): number {
  const hotspotHubCount = input.hotspots.hotspots.filter(
    (hotspot) => hotspot.type === "dependency_hub",
  ).length;
  const architectureHubCount = input.architecture.mostConnectedModules.filter(
    (module) => module.totalConnections >= 4,
  ).length;

  return Math.max(hotspotHubCount, architectureHubCount);
}

function collectSignals(input: RepositoryRiskInput): RepositoryRiskSignals {
  const criticalInsights = input.insights.insights.filter(
    (insight) => insight.severity === "critical",
  ).length;
  const warningInsights = input.insights.insights.filter(
    (insight) => insight.severity === "warning",
  ).length;

  return {
    healthy: input.health.healthy,
    indexed: input.health.signals.indexed,
    ready: input.health.signals.ready,
    stale: input.health.signals.stale,
    healthScore: input.health.score,
    architectureComplexityScore: input.architecture.architectureComplexityScore,
    totalFiles: input.architecture.totalFiles,
    totalDependencies: input.architecture.totalDependencies,
    circularDependencyCount: input.architecture.circularDependencyCount,
    dependencyHubCount: dependencyHubCount(input),
    criticalHotspots: input.hotspots.summary.critical,
    highHotspots: input.hotspots.summary.high,
    mediumHotspots: input.hotspots.summary.medium,
    lowHotspots: input.hotspots.summary.low,
    criticalInsights,
    warningInsights,
    failedIndexingSignals: failedIndexingSignals(input.health),
  };
}

function scoreRisk(signals: RepositoryRiskSignals): number {
  let score = 0;

  score += Math.max(0, 100 - signals.healthScore) * 0.2;
  score += signals.healthy ? 0 : 18;
  score += signals.stale ? 12 : 0;
  score += signals.indexed ? 0 : 28;
  score += signals.ready ? 0 : 18;
  score += signals.failedIndexingSignals * 18;
  score += signals.architectureComplexityScore * 0.25;
  score += signals.circularDependencyCount * 14;
  score += signals.dependencyHubCount * 8;
  score += signals.criticalHotspots * 18;
  score += signals.highHotspots * 10;
  score += signals.mediumHotspots * 5;
  score += signals.lowHotspots * 2;
  score += signals.criticalInsights * 14;
  score += signals.warningInsights * 5;

  return clampScore(score);
}

function collectStrengths(signals: RepositoryRiskSignals): string[] {
  const strengths: string[] = [];

  if (signals.healthy) strengths.push("Repository health is in a safe range.");
  if (signals.indexed) strengths.push("Repository is indexed.");
  if (signals.ready) strengths.push("Repository is ready for AI-assisted analysis.");
  if (!signals.stale) strengths.push("Repository index is fresh.");
  if (signals.circularDependencyCount === 0) {
    strengths.push("No circular dependency groups were reported.");
  }
  if (signals.architectureComplexityScore < 40) {
    strengths.push("Architecture complexity is low.");
  }
  if (signals.criticalHotspots === 0 && signals.criticalInsights === 0) {
    strengths.push("No critical hotspot or insight signals were reported.");
  }

  return sortedUnique(strengths);
}

function collectRisks(signals: RepositoryRiskSignals): string[] {
  const risks: string[] = [];

  if (!signals.healthy) risks.push("Repository health is below the healthy threshold.");
  if (signals.stale) risks.push("Repository index is stale.");
  if (!signals.indexed) risks.push("Repository is not indexed.");
  if (!signals.ready) risks.push("Repository is not ready for AI-assisted analysis.");
  if (signals.failedIndexingSignals > 0) risks.push("Indexing failure signals are present.");
  if (signals.architectureComplexityScore >= 70) {
    risks.push("Architecture complexity is high.");
  } else if (signals.architectureComplexityScore >= 40) {
    risks.push("Architecture complexity is elevated.");
  }
  if (signals.circularDependencyCount > 0) {
    risks.push("Circular dependency groups are present.");
  }
  if (signals.dependencyHubCount > 0) {
    risks.push("Central dependency hubs are present.");
  }
  if (signals.criticalHotspots > 0) risks.push("Critical hotspot signals are present.");
  if (signals.highHotspots > 0) risks.push("High-severity hotspot signals are present.");
  if (signals.criticalInsights > 0) risks.push("Critical insight signals are present.");
  if (signals.warningInsights > 0) risks.push("Warning insight signals are present.");

  return sortedUnique(risks);
}

function collectBlockers(signals: RepositoryRiskSignals): string[] {
  const blockers: string[] = [];

  if (!signals.indexed) blockers.push("Index the repository before relying on analysis.");
  if (!signals.ready) blockers.push("Resolve readiness blockers before using AI analysis.");
  if (signals.failedIndexingSignals > 0) blockers.push("Resolve indexing failures.");
  if (signals.criticalHotspots > 0) blockers.push("Resolve critical architecture hotspots.");
  if (signals.criticalInsights > 0) blockers.push("Review critical insight findings.");

  return sortedUnique(blockers);
}

function summaryFor(level: RepositoryRiskLevel, score: number): string {
  return `Repository risk is ${level.toLowerCase()} (${score}/100).`;
}

export function analyzeRepositoryRisk(input: RepositoryRiskInput): RepositoryRiskReport {
  const signals = collectSignals(input);
  const score = scoreRisk(signals);
  const level = riskLevel(score);

  return {
    repositoryId: repositoryIdFor(input),
    score,
    level,
    summary: summaryFor(level, score),
    strengths: collectStrengths(signals),
    risks: collectRisks(signals),
    blockers: collectBlockers(signals),
    signals: { ...signals },
  };
}
