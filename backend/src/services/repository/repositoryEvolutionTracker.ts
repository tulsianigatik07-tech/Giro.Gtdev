import type { RepositoryArchitectureAnalysis } from "./repositoryArchitectureAnalyzer.js";
import type { RepositoryAiReadinessResult } from "./repositoryAiReadinessEngine.js";
import type { RepositoryHealthEngineResult } from "./repositoryHealthEngine.js";
import type { RepositoryHotspot, RepositoryHotspotReport } from "./repositoryHotspotAnalyzer.js";
import type { RepositoryInsightsEngineResult } from "./repositoryInsightsEngine.js";
import type { RepositoryRiskReport } from "./repositoryRiskAnalyzer.js";

export type RepositoryEvolutionTrend = "IMPROVING" | "STABLE" | "REGRESSING";

export interface RepositoryEvolutionSnapshot {
  repositoryId?: string;
  health: RepositoryHealthEngineResult;
  aiReadiness: RepositoryAiReadinessResult;
  architecture: RepositoryArchitectureAnalysis;
  hotspots: RepositoryHotspotReport;
  insights: RepositoryInsightsEngineResult;
  risk: RepositoryRiskReport;
}

export interface RepositoryEvolutionReport {
  repositoryId: string;
  trend: RepositoryEvolutionTrend;
  scoreDelta: number;
  healthDelta: number;
  readinessDelta: number;
  riskDelta: number;
  newHotspots: RepositoryHotspot[];
  resolvedHotspots: RepositoryHotspot[];
  newBlockers: string[];
  resolvedBlockers: string[];
  improvements: string[];
  regressions: string[];
  summary: string;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function copyHotspot(hotspot: RepositoryHotspot): RepositoryHotspot {
  return {
    id: hotspot.id,
    type: hotspot.type,
    severity: hotspot.severity,
    title: hotspot.title,
    description: hotspot.description,
    affectedModules: sortedUnique(hotspot.affectedModules),
    reason: hotspot.reason,
  };
}

function sortHotspots(hotspots: readonly RepositoryHotspot[]): RepositoryHotspot[] {
  return hotspots
    .map(copyHotspot)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function hotspotMap(
  hotspots: readonly RepositoryHotspot[],
): Map<string, RepositoryHotspot> {
  const map = new Map<string, RepositoryHotspot>();
  for (const hotspot of hotspots) {
    map.set(hotspot.id, copyHotspot(hotspot));
  }
  return map;
}

function addedHotspots(
  previous: readonly RepositoryHotspot[],
  current: readonly RepositoryHotspot[],
): RepositoryHotspot[] {
  const previousIds = new Set(previous.map((hotspot) => hotspot.id));
  return sortHotspots(current.filter((hotspot) => !previousIds.has(hotspot.id)));
}

function removedHotspots(
  previous: readonly RepositoryHotspot[],
  current: readonly RepositoryHotspot[],
): RepositoryHotspot[] {
  const currentIds = new Set(current.map((hotspot) => hotspot.id));
  return sortHotspots(previous.filter((hotspot) => !currentIds.has(hotspot.id)));
}

function repositoryIdFor(
  previousReport: RepositoryEvolutionSnapshot,
  currentReport: RepositoryEvolutionSnapshot,
): string {
  return (
    currentReport.repositoryId ??
    currentReport.health.repositoryId ??
    currentReport.aiReadiness.repositoryId ??
    currentReport.hotspots.repositoryId ??
    currentReport.insights.repositoryId ??
    currentReport.risk.repositoryId ??
    previousReport.repositoryId ??
    previousReport.health.repositoryId ??
    "unknown"
  );
}

function criticalInsightCount(report: RepositoryEvolutionSnapshot): number {
  return report.insights.insights.filter(
    (insight) => insight.severity === "critical",
  ).length;
}

function indexingAvailable(report: RepositoryEvolutionSnapshot): boolean {
  return report.health.signals.indexed && report.health.signals.ready;
}

function pushDeltaSignal(
  improvements: string[],
  regressions: string[],
  delta: number,
  improvedMessage: string,
  regressedMessage: string,
): void {
  if (delta > 0) improvements.push(improvedMessage);
  if (delta < 0) regressions.push(regressedMessage);
}

function buildSignals(input: {
  previousReport: RepositoryEvolutionSnapshot;
  currentReport: RepositoryEvolutionSnapshot;
  healthDelta: number;
  readinessDelta: number;
  riskDelta: number;
  newHotspots: readonly RepositoryHotspot[];
  resolvedHotspots: readonly RepositoryHotspot[];
  newBlockers: readonly string[];
  resolvedBlockers: readonly string[];
}): { improvements: string[]; regressions: string[] } {
  const { previousReport, currentReport } = input;
  const improvements: string[] = [];
  const regressions: string[] = [];

  pushDeltaSignal(
    improvements,
    regressions,
    input.healthDelta,
    "Health score improved.",
    "Health score declined.",
  );
  pushDeltaSignal(
    improvements,
    regressions,
    input.readinessDelta,
    "AI readiness score improved.",
    "AI readiness score declined.",
  );
  if (input.riskDelta < 0) improvements.push("Repository risk decreased.");
  if (input.riskDelta > 0) regressions.push("Repository risk increased.");

  if (input.resolvedHotspots.length > 0) improvements.push("Hotspots were resolved.");
  if (input.newHotspots.length > 0) regressions.push("New hotspots appeared.");
  if (input.resolvedBlockers.length > 0) improvements.push("Blockers were resolved.");
  if (input.newBlockers.length > 0) regressions.push("New blockers appeared.");

  if (
    currentReport.architecture.architectureComplexityScore <
    previousReport.architecture.architectureComplexityScore
  ) {
    improvements.push("Architecture complexity decreased.");
  }
  if (
    currentReport.architecture.architectureComplexityScore >
    previousReport.architecture.architectureComplexityScore
  ) {
    regressions.push("Architecture complexity increased.");
  }

  if (criticalInsightCount(currentReport) < criticalInsightCount(previousReport)) {
    improvements.push("Critical insights were reduced.");
  }
  if (criticalInsightCount(currentReport) > criticalInsightCount(previousReport)) {
    regressions.push("Critical insights increased.");
  }

  if (!previousReport.health.signals.stale && currentReport.health.signals.stale) {
    regressions.push("Repository became stale.");
  }
  if (previousReport.health.signals.stale && !currentReport.health.signals.stale) {
    improvements.push("Repository freshness improved.");
  }

  if (!indexingAvailable(previousReport) && indexingAvailable(currentReport)) {
    improvements.push("Indexing availability improved.");
  }
  if (indexingAvailable(previousReport) && !indexingAvailable(currentReport)) {
    regressions.push("Indexing availability regressed.");
  }

  return {
    improvements: sortedUnique(improvements),
    regressions: sortedUnique(regressions),
  };
}

function weightedTrend(input: {
  healthDelta: number;
  readinessDelta: number;
  riskDelta: number;
  newHotspots: readonly RepositoryHotspot[];
  resolvedHotspots: readonly RepositoryHotspot[];
  newBlockers: readonly string[];
  resolvedBlockers: readonly string[];
  improvements: readonly string[];
  regressions: readonly string[];
}): RepositoryEvolutionTrend {
  let score = 0;
  score += input.healthDelta * 0.2;
  score += input.readinessDelta * 0.2;
  score -= input.riskDelta * 0.3;
  score += input.resolvedHotspots.length * 4;
  score -= input.newHotspots.length * 4;
  score += input.resolvedBlockers.length * 6;
  score -= input.newBlockers.length * 6;
  score += input.improvements.length;
  score -= input.regressions.length;

  if (score >= 3) return "IMPROVING";
  if (score <= -3) return "REGRESSING";
  return "STABLE";
}

function summaryFor(trend: RepositoryEvolutionTrend): string {
  if (trend === "IMPROVING") return "Repository intelligence is improving.";
  if (trend === "REGRESSING") return "Repository intelligence is regressing.";
  return "Repository intelligence is stable.";
}

export function trackRepositoryEvolution(
  previousReport: RepositoryEvolutionSnapshot,
  currentReport: RepositoryEvolutionSnapshot,
): RepositoryEvolutionReport {
  const previousHotspots = hotspotMap(previousReport.hotspots.hotspots);
  const currentHotspots = hotspotMap(currentReport.hotspots.hotspots);
  const newHotspots = addedHotspots(
    [...previousHotspots.values()],
    [...currentHotspots.values()],
  );
  const resolvedHotspots = removedHotspots(
    [...previousHotspots.values()],
    [...currentHotspots.values()],
  );
  const newBlockers = sortedUnique(
    currentReport.risk.blockers.filter(
      (blocker) => !previousReport.risk.blockers.includes(blocker),
    ),
  );
  const resolvedBlockers = sortedUnique(
    previousReport.risk.blockers.filter(
      (blocker) => !currentReport.risk.blockers.includes(blocker),
    ),
  );
  const healthDelta = currentReport.health.score - previousReport.health.score;
  const readinessDelta =
    currentReport.aiReadiness.score - previousReport.aiReadiness.score;
  const riskDelta = currentReport.risk.score - previousReport.risk.score;
  const scoreDelta = Math.round(healthDelta + readinessDelta - riskDelta);
  const signals = buildSignals({
    previousReport,
    currentReport,
    healthDelta,
    readinessDelta,
    riskDelta,
    newHotspots,
    resolvedHotspots,
    newBlockers,
    resolvedBlockers,
  });
  const trend = weightedTrend({
    healthDelta,
    readinessDelta,
    riskDelta,
    newHotspots,
    resolvedHotspots,
    newBlockers,
    resolvedBlockers,
    improvements: signals.improvements,
    regressions: signals.regressions,
  });

  return {
    repositoryId: repositoryIdFor(previousReport, currentReport),
    trend,
    scoreDelta,
    healthDelta,
    readinessDelta,
    riskDelta,
    newHotspots,
    resolvedHotspots,
    newBlockers,
    resolvedBlockers,
    improvements: signals.improvements,
    regressions: signals.regressions,
    summary: summaryFor(trend),
  };
}
